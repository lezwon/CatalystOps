/**
 * Plan Parser - Parses explain("formatted") output for join types, shuffles, and other issues.
 */

import { AnalysisResult, ClusterInfo } from '../models/types';

export interface PlanIssue {
    type: 'join' | 'shuffle' | 'statistics' | 'pushdown' | 'cache' | 'format' | 'partition' | 'aggregation';
    name: string;
    description: string;
    costPoints: number;
    planLine?: string;
    tableName?: string;
}

/**
 * Parse Spark explain() output for optimization issues.
 * Accepts optional cluster info for memory-aware checks (e.g. cache spill risk).
 */
export function parsePlan(planText: string, cluster?: ClusterInfo): PlanIssue[] {
    const issues: PlanIssue[] = [];
    const lines = planText.split('\n');
    let lastScannedTable: string | null = null;

    // State for multi-line context detection
    const seenInMemoryKeys = new Set<string>();
    const seenFileScanPaths = new Map<string, number>();

    // AQE plans contain both "== Final Plan ==" and "== Initial Plan ==" sections.
    // FileScan nodes appear in both, which causes false-positive RepeatedFileScan.
    // Only analyse the Final Plan (or non-AQE plan) — skip everything after Initial Plan header.
    let inInitialPlan = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (/==\s*Initial Plan\s*==/i.test(trimmed)) { inInitialPlan = true; }
        if (inInitialPlan) { continue; }

        // ── Join type detection ────────────────────────────────────────────────

        if (/BroadcastHashJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'BroadcastHashJoin',
                description: 'Broadcast hash join detected (efficient for small tables).',
                costPoints: 1,
                planLine: trimmed,
            });

            // BroadcastHashJoin with Exchange SinglePartition: broadcast result
            // funnelled to one executor — creates a bottleneck.
            for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                if (/Exchange\s+SinglePartition/i.test(lines[j])) {
                    issues.push({
                        type: 'join',
                        name: 'BroadcastJoinSinglePartition',
                        description:
                            'BroadcastHashJoin result is collected via Exchange SinglePartition, ' +
                            'sending all data to one executor. This creates a severe bottleneck. ' +
                            'Avoid global scalar aggregations after a broadcast join where possible, ' +
                            'or confirm the final result set is small enough to justify it.',
                        costPoints: 60,
                        planLine: trimmed,
                    });
                    break;
                }
            }

        } else if (/SortMergeJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'SortMergeJoin',
                description:
                    'Sort-merge join requires sorting both inputs and shuffling data across the cluster. ' +
                    'If either side is small, force a broadcast join with the broadcast() hint or increase ' +
                    'spark.sql.autoBroadcastJoinThreshold.',
                costPoints: 50,
                planLine: trimmed,
            });

            // Look for a broadcastable small side within the next 20 lines
            const segment = lines.slice(i, Math.min(i + 20, lines.length)).join('\n');
            const smallSide = findSmallSide(segment);
            if (smallSide !== null && smallSide < 200 * 1024 * 1024) {
                issues.push({
                    type: 'join',
                    name: 'BroadcastableSmallSide',
                    description:
                        `One side of this SortMergeJoin is only ${formatBytes(smallSide)} — ` +
                        'small enough to broadcast, but Spark chose a sort-merge join. ' +
                        'Use the broadcast() hint: df_large.join(broadcast(df_small), ...) ' +
                        `or raise spark.sql.autoBroadcastJoinThreshold above ${smallSide}.`,
                    costPoints: 30,
                    planLine: trimmed,
                });
            }

        } else if (/ShuffledHashJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'ShuffledHashJoin',
                description:
                    'Shuffled hash join: consider broadcasting the smaller table if it fits in memory.',
                costPoints: 30,
                planLine: trimmed,
            });

        } else if (/CartesianProduct/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'CartesianProduct',
                description:
                    'Cartesian product detected! This produces an O(n×m) result set and is extremely expensive. ' +
                    'Add a join condition or use a broadcast join instead.',
                costPoints: 1000,
                planLine: trimmed,
            });

        } else if (/BroadcastNestedLoopJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'BroadcastNestedLoopJoin',
                description:
                    'Broadcast nested loop join detected. This is expensive for large datasets — ' +
                    'add join keys to allow a hash or sort-merge join instead.',
                costPoints: 80,
                planLine: trimmed,
            });
        }

        // ── Shuffle (Exchange) detection ───────────────────────────────────────

        if (/\bExchange\b/i.test(trimmed) && !/BroadcastExchange/i.test(trimmed)) {
            issues.push({
                type: 'shuffle',
                name: 'Exchange',
                description: 'Shuffle exchange: data is being redistributed across partitions.',
                costPoints: 20,
                planLine: trimmed,
            });

            // Too few shuffle partitions for the data volume
            const partsMatch = trimmed.match(/hashpartitioning\([^)]+,\s*(\d+)\)/i);
            if (partsMatch) {
                const numParts = parseInt(partsMatch[1], 10);
                const nearbyText = lines.slice(Math.max(0, i - 5), Math.min(i + 5, lines.length)).join('\n');
                const dataSize = parseSizeBytes(nearbyText);

                if (numParts <= 1) {
                    issues.push({
                        type: 'partition',
                        name: 'TooFewShufflePartitions',
                        description:
                            `Shuffle is writing to only ${numParts} partition(s), concentrating all data ` +
                            'on a single task. This causes OOM errors and eliminates parallelism. ' +
                            'Set spark.conf.set("spark.sql.shuffle.partitions", 200) or call repartition().',
                        costPoints: 50,
                        planLine: trimmed,
                    });
                } else if (numParts < 10 && dataSize !== null && dataSize > 500 * 1024 * 1024) {
                    issues.push({
                        type: 'partition',
                        name: 'TooFewShufflePartitions',
                        description:
                            `Only ${numParts} shuffle partition(s) for ${formatBytes(dataSize)} of data. ` +
                            'Each partition will be very large, risking spill and slow processing. ' +
                            'Increase spark.sql.shuffle.partitions or call repartition().',
                        costPoints: 35,
                        planLine: trimmed,
                    });
                } else if (numParts === 200) {
                    // Default partition count — check if data volume justifies more partitions.
                    // Look wider (±15 lines) because Statistics may be on a parent/child node.
                    const wideText = lines.slice(Math.max(0, i - 15), Math.min(i + 15, lines.length)).join('\n');
                    const wideSize = parseSizeBytes(wideText);
                    if (wideSize !== null && wideSize > 20 * 1024 ** 3) {
                        const avgMB = (wideSize / numParts) / (1024 ** 2);
                        const optimalParts = Math.ceil(wideSize / (200 * 1024 ** 2)); // target ~200 MB/partition
                        issues.push({
                            type: 'partition',
                            name: 'DefaultShufflePartitions',
                            description:
                                `Exchange hashpartitioning uses the default 200 partitions for ${formatBytes(wideSize)} of data ` +
                                `(~${avgMB.toFixed(0)} MB per partition). This is likely under-partitioned — large partitions ` +
                                `cause slow tasks and spill to disk. ` +
                                `Increase to ~${optimalParts} partitions (targeting ~200 MB each).`,
                            costPoints: 40,
                            planLine: trimmed,
                        });
                    }
                }
            }
        }

        // ── Table name extraction (for statistics warnings) ────────────────────

        const fileScanMatch = trimmed.match(/FileScan\s+parquet\s+([\w.]+)/i);
        const hiveScanMatch = trimmed.match(/HiveTableScan\s+.*?\s+([\w.]+)/i);
        const scannedTable = fileScanMatch?.[1] || hiveScanMatch?.[1];
        if (scannedTable) {
            lastScannedTable = scannedTable;
        }

        // ── Missing statistics ─────────────────────────────────────────────────

        if (/Statistics\(sizeInBytes=.*?=-1\)/i.test(trimmed) ||
            (/unknown/i.test(trimmed) && /statistic/i.test(trimmed))) {
            const tableName = lastScannedTable || undefined;
            issues.push({
                type: 'statistics',
                name: 'MissingStatistics',
                description: tableName
                    ? `No statistics found for table ${tableName}. ` +
                      `Run ANALYZE TABLE ${tableName} COMPUTE STATISTICS to enable better join optimization.`
                    : 'Table statistics are missing. Run ANALYZE TABLE ... COMPUTE STATISTICS ' +
                      'to help the optimizer make better join and partition decisions.',
                costPoints: 15,
                planLine: trimmed,
                tableName,
            });
        }

        // ── InMemoryRelation: cache size and re-scan detection ─────────────────

        if (/InMemoryRelation/i.test(trimmed)) {
            // Build a fingerprint from the column list to detect re-scans of the same cache
            const colMatch = trimmed.match(/InMemoryRelation\s+\[([^\]]+)\]/);
            const fp = colMatch ? colMatch[1] : trimmed.substring(trimmed.indexOf('InMemoryRelation'), 80);

            if (seenInMemoryKeys.has(fp)) {
                issues.push({
                    type: 'cache',
                    name: 'CacheRescan',
                    description:
                        'A cached relation is being re-scanned multiple times in this query. ' +
                        'This happens when the same cached DataFrame is referenced in multiple branches ' +
                        'of the plan. Consider materialising the intermediate result or restructuring ' +
                        'the query to read the cache only once.',
                    costPoints: 25,
                    planLine: trimmed,
                });
            } else {
                seenInMemoryKeys.add(fp);
            }

            // ── Disk spill: data already stored on or overflowing to disk ────────

            if (/StorageLevel\s*\(/i.test(trimmed)) {
                const hasMemory = /StorageLevel\s*\([^)]*\bmemory\b/i.test(trimmed);
                const hasDisk   = /StorageLevel\s*\([^)]*\bdisk\b/i.test(trimmed);

                if (hasDisk && hasMemory) {
                    // MEMORY_AND_DISK — overflowed to disk, spill is occurring
                    issues.push({
                        type: 'cache',
                        name: 'CacheDiskSpill',
                        description:
                            'Cached DataFrame is spilling to disk (MEMORY_AND_DISK storage level). ' +
                            'The dataset exceeds available executor memory. ' +
                            'Cache a narrower projection (.select(...).cache()), ' +
                            'increase executor memory, or remove the cache entirely if recompute is cheaper.',
                        costPoints: 70,
                        planLine: trimmed,
                    });
                } else if (hasDisk && !hasMemory) {
                    // DISK_ONLY — every read goes to disk, potentially slower than recomputing
                    issues.push({
                        type: 'cache',
                        name: 'CacheDiskSpill',
                        description:
                            'Cached DataFrame uses DISK_ONLY storage — all reads require disk I/O. ' +
                            'This can be slower than recomputing from source for simple transformations. ' +
                            'Increase executor memory to allow in-memory caching, or remove cache() if reads are infrequent.',
                        costPoints: 50,
                        planLine: trimmed,
                    });
                }

                // ── Deserialized Java objects — high heap and GC pressure ─────────
                if (/StorageLevel\s*\([^)]*\bdeserialized\b/i.test(trimmed)) {
                    issues.push({
                        type: 'cache',
                        name: 'CacheDeserialized',
                        description:
                            'Cached DataFrame uses deserialized Java objects (MEMORY_ONLY default). ' +
                            'Deserialized storage consumes 3-5× more heap than Kryo-serialized storage ' +
                            'and causes heavy GC pressure on large DataFrames. ' +
                            'Enable Kryo and use MEMORY_ONLY_SER to significantly reduce memory usage.',
                        costPoints: 30,
                        planLine: trimmed,
                    });
                }
            }

            // Memory spill risk: compare sizeInBytes against cluster storage capacity
            const sizeBytes = parseSizeBytes(trimmed);
            if (sizeBytes !== null) {
                const isDeserialized = /deserialized/i.test(trimmed);
                const spill = checkCacheSpillRisk(sizeBytes, cluster);

                if (spill === 'high') {
                    issues.push({
                        type: 'cache',
                        name: 'CacheMemorySpillRisk',
                        description:
                            `Cached relation is ${formatBytes(sizeBytes)} but exceeds estimated cluster ` +
                            'storage capacity — data will spill to disk and degrade cache read performance. ' +
                            'Options: (1) increase cluster size, (2) cache only needed columns with ' +
                            '.select(...).cache(), (3) switch to StorageLevel.DISK_ONLY to avoid OOM.',
                        costPoints: 80,
                        planLine: trimmed,
                    });
                } else if (spill === 'warn' || sizeBytes > 10 * 1024 ** 3) {
                    issues.push({
                        type: 'cache',
                        name: 'LargeCache',
                        description:
                            `Cached relation is ${formatBytes(sizeBytes)}. ` +
                            (isDeserialized
                                ? 'StorageLevel DESERIALIZED is the most memory-intensive storage level. ' +
                                  'For large datasets consider MEMORY_AND_DISK_SER to reduce pressure.'
                                : 'Verify your cluster has sufficient free executor memory to avoid spilling to disk.'),
                        costPoints: 30,
                        planLine: trimmed,
                    });
                }
            }
        }

        // ── CSV / text format reads ────────────────────────────────────────────

        if (/FileScan\s+(csv|text)\b/i.test(trimmed) ||
            /Format:\s*(CSV|Text)\b/i.test(trimmed) ||
            (/\bScan\b/i.test(trimmed) && /\.csv\b/i.test(trimmed))) {
            issues.push({
                type: 'format',
                name: 'CsvRead',
                description:
                    'Reading CSV/text format disables columnar reads, predicate pushdown, and vectorized ' +
                    'execution. Convert to Parquet or Delta Lake for significantly faster queries:\n' +
                    '  df.write.parquet("path/")   →   spark.read.parquet("path/")\n' +
                    '  df.write.format("delta").save("path/")   →   spark.read.format("delta").load("path/")\n' +
                    'After converting, cache the DataFrame if it is read more than once.',
                costPoints: 40,
                planLine: trimmed,
            });
        }

        // ── first() aggregation without ordering guarantee ─────────────────────

        if (/\bfirst\s*\(/i.test(trimmed) &&
            /(?:HashAggregate|ObjectHashAggregate|SortAggregate)/i.test(trimmed)) {
            issues.push({
                type: 'aggregation',
                name: 'FirstWithoutOrdering',
                description:
                    'first() aggregation detected. In distributed execution first() returns an arbitrary ' +
                    'value — the result is non-deterministic and can change between runs. ' +
                    'If a specific value is required, sort first: df.orderBy("col").groupBy(...).agg(first("val")), ' +
                    'or use min() / max() if ordering semantics apply.',
                costPoints: 15,
                planLine: trimmed,
            });
        }

        // ── Repeated FileScan → suggest caching ───────────────────────────────

        const fileScanPath = extractFileScanPath(trimmed);
        if (fileScanPath) {
            const scanSize = parseSizeBytes(trimmed);
            const count = (seenFileScanPaths.get(fileScanPath) ?? 0) + 1;
            seenFileScanPaths.set(fileScanPath, count);
            if (count === 2) {
                const isLarge = scanSize !== null && scanSize > 512 * 1024 * 1024;
                issues.push({
                    type: 'cache',
                    name: 'RepeatedFileScan',
                    description: isLarge
                        ? `"${fileScanPath}" (${formatBytes(scanSize!)}) is scanned more than once without caching. ` +
                          'Reading this large dataset repeatedly is very expensive. Cache after the first read.'
                        : `"${fileScanPath}" is scanned more than once without caching. ` +
                          'Cache after the first read to avoid repeated I/O.',
                    costPoints: isLarge ? 60 : 30,
                    planLine: trimmed,
                    tableName: fileScanPath,
                });
            }
        }

        // ── Large DataFrame being persisted ───────────────────────────────────

        if (/InMemoryRelation/i.test(trimmed)) {
            const sizeBytes = parseSizeBytes(trimmed);
            if (sizeBytes !== null && sizeBytes > 5 * 1024 ** 3) {
                const spill = checkCacheSpillRisk(sizeBytes, cluster);
                if (spill === 'ok') {
                    // Large but fits in memory — warn to cache selectively
                    issues.push({
                        type: 'cache',
                        name: 'LargeDfPersisted',
                        description:
                            `A ${formatBytes(sizeBytes)} DataFrame is being cached. ` +
                            'Verify that all columns are needed in the cache — caching a narrow projection reduces memory pressure:\n' +
                            '  df.select("col1", "col2").cache()  # cache only needed columns',
                        costPoints: 25,
                        planLine: trimmed,
                    });
                }
                // Note: spill === 'warn' / 'high' are handled by LargeCache / CacheMemorySpillRisk above
            }
        }
    }

    return issues;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse a "sizeInBytes=X Unit" string from plan text into bytes. */
function parseSizeBytes(text: string): number | null {
    const m = text.match(/sizeInBytes=([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/i);
    if (!m) { return null; }
    const val = parseFloat(m[1]);
    const units: Record<string, number> = {
        B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
    };
    return val * (units[m[2]] ?? 1);
}

/** Parse an executor memory string like "28g" or "512m" into bytes. */
function parseMemoryBytes(s: string | undefined): number | null {
    if (!s) { return null; }
    const m = s.match(/^([\d.]+)\s*([kmgt]?)/i);
    if (!m) { return null; }
    const val = parseFloat(m[1]);
    const factors: Record<string, number> = {
        '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
    };
    return val * (factors[m[2].toLowerCase()] ?? 1);
}

/** Format a byte count into a human-readable string. */
function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 4) { return `${(bytes / 1024 ** 4).toFixed(1)} TiB`; }
    if (bytes >= 1024 ** 3) { return `${(bytes / 1024 ** 3).toFixed(1)} GiB`; }
    if (bytes >= 1024 ** 2) { return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }
    if (bytes >= 1024) { return `${(bytes / 1024).toFixed(1)} KiB`; }
    return `${bytes} B`;
}

/**
 * Estimate whether a cache of `sizeBytes` risks spilling to disk given cluster info.
 * Spark's default storage fraction is ~30% of executor memory
 * (spark.memory.fraction=0.6 × spark.memory.storageFraction=0.5).
 */
function checkCacheSpillRisk(sizeBytes: number, cluster?: ClusterInfo): 'high' | 'warn' | 'ok' {
    if (!cluster) {
        return sizeBytes > 100 * 1024 ** 3 ? 'warn' : 'ok';
    }
    const execMemBytes = parseMemoryBytes(cluster.executorMemory) ?? 0;
    const storageCapacity = execMemBytes * Math.max(cluster.workers, 1) * 0.3;
    if (storageCapacity > 0) {
        if (sizeBytes > storageCapacity) { return 'high'; }
        if (sizeBytes > storageCapacity * 0.7) { return 'warn'; }
    }
    return sizeBytes > 10 * 1024 ** 3 ? 'warn' : 'ok';
}

/**
 * Find the smallest sizeInBytes value in a plan segment (used to detect
 * a broadcastable small side of a SortMergeJoin).
 * Returns null if fewer than 2 sizes are found (need both sides).
 */
function findSmallSide(segment: string): number | null {
    const sizes: number[] = [];
    const re = /sizeInBytes=([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/gi;
    let m: RegExpExecArray | null;
    const units: Record<string, number> = {
        B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
    };
    while ((m = re.exec(segment)) !== null) {
        sizes.push(parseFloat(m[1]) * (units[m[2]] ?? 1));
    }
    return sizes.length >= 2 ? Math.min(...sizes) : null;
}

/** Extract a stable table/path identifier from a FileScan line. */
function extractFileScanPath(trimmed: string): string | null {
    // Format 1: FileScan parquet schema.table[columns...]
    const tableMatch = trimmed.match(/FileScan\s+\w+\s+([\w.]+)\s*\[/i);
    if (tableMatch) { return tableMatch[1]; }

    // Format 2: FileScan csv [/path/to/file.csv, ...][columns...]
    const pathMatch = trimmed.match(/FileScan\s+\w+\s+\[([^[\]]+)\]/i);
    if (pathMatch) {
        const first = pathMatch[1].split(',')[0].trim().replace(/^file:/i, '');
        const parts = first.replace(/\\/g, '/').split('/').filter(Boolean);
        // Use last two path segments as a stable key (dir/filename)
        return parts.length >= 2 ? parts.slice(-2).join('/') : first;
    }

    return null;
}

/**
 * Parse the analyzed logical plan for repeated table reads.
 *
 * The analyzed logical plan preserves the original table references before
 * Catalyst optimization — SubqueryAlias nodes identify each table access.
 * When the same alias appears twice, the table is read without caching.
 */
export function parseLogicalPlan(planText: string): PlanIssue[] {
    if (!planText) { return []; }
    const issues: PlanIssue[] = [];
    const seenAliases = new Map<string, number>();

    for (const line of planText.split('\n')) {
        const trimmed = line.trim();

        // SubqueryAlias schema.table  or  SubqueryAlias table_name
        const aliasMatch = trimmed.match(/^SubqueryAlias\s+([\w.]+)/i);
        if (!aliasMatch) { continue; }

        const name = aliasMatch[1];
        // Skip Spark internal aliases (spark_catalog prefix is fine; skip anonymous __auto_generated_...)
        if (name.startsWith('__') || name === 'spark_catalog') { continue; }

        const count = (seenAliases.get(name) ?? 0) + 1;
        seenAliases.set(name, count);

        if (count === 2) {
            // Strip catalog prefix to get a short display name
            const shortName = name.split('.').slice(-1)[0];
            issues.push({
                type: 'cache',
                name: 'RepeatedFileScan',
                description:
                    `Table "${shortName}" is read ${count}+ times without caching. ` +
                    'Each reference triggers a separate scan. Cache after the first read to reuse the result.',
                costPoints: 40,
                planLine: trimmed,
                tableName: name,
            });
        }
    }

    return issues;
}

/** Format a byte count into a human-readable string. Exported for use in UI layers. */
export function formatPlanBytes(bytes: number): string {
    if (bytes >= 1024 ** 4) { return `${(bytes / 1024 ** 4).toFixed(1)} TiB`; }
    if (bytes >= 1024 ** 3) { return `${(bytes / 1024 ** 3).toFixed(1)} GiB`; }
    if (bytes >= 1024 ** 2) { return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }
    if (bytes >= 1024) { return `${(bytes / 1024).toFixed(1)} KiB`; }
    return `${bytes} B`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Calculate total cost score from plan issues. */
export function calculatePlanCost(issues: PlanIssue[]): number {
    return issues.reduce((total, issue) => total + issue.costPoints, 0);
}

/**
 * Parse plan data from cluster analysis results.
 * Analyses both physical plan (for FileScan, caches, joins) and
 * analyzed logical plan (for repeated table reads — cleaner table names).
 */
export function parsePlanFromResults(results: AnalysisResult[]): PlanIssue[] {
    const allIssues: PlanIssue[] = [];
    for (const result of results) {
        if (result.executionPlan?.physicalPlan) {
            allIssues.push(...parsePlan(result.executionPlan.physicalPlan, result.cluster));
        }
        // Logical plan gives cleaner table names for repeated-read detection.
        // Results are merged with physical plan results below.
        if (result.executionPlan?.logicalPlan) {
            allIssues.push(...parseLogicalPlan(result.executionPlan.logicalPlan));
        }
    }

    // Deduplicate: prefer issues with a tableName (more informative) when the
    // same issue name appears multiple times. Otherwise keep first seen.
    const seen = new Map<string, PlanIssue>();
    for (const issue of allIssues) {
        const existing = seen.get(issue.name);
        if (!existing || (!existing.tableName && issue.tableName)) {
            seen.set(issue.name, issue);
        }
    }
    return Array.from(seen.values());
}

export interface RootStats {
    /** Output row count. null = not present or unknown (-1). */
    rowCount: number | null;
    /** Output size in bytes. null = not present. */
    sizeInBytes: number | null;
    /** True when AQE collected these at runtime; false = optimizer estimate. */
    isRuntime: boolean;
}

/**
 * Extract output-level statistics for a DataFrame from its physical plan text.
 *
 * Spark prints statistics on each QueryStage / operator node. The first
 * Statistics(...) encountered scanning top-to-bottom belongs to the root
 * output node (ResultQueryStage for AQE plans, or the top-level operator
 * for non-AQE plans) — this represents the final result set of the query.
 *
 * rowCount values can be integers or scientific notation (e.g. 2.51E+4).
 */
export function extractRootStats(planText: string): RootStats {
    const statsRe = /Statistics\(([^)]+)\)/i;

    for (const line of planText.split('\n')) {
        const m = statsRe.exec(line);
        if (!m) { continue; }

        const inner = m[1];
        const isRuntime = /isRuntime=true/i.test(inner);

        // sizeInBytes=785.9 KiB
        const sizeMatch = inner.match(/sizeInBytes=([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/i);
        let sizeInBytes: number | null = null;
        if (sizeMatch) {
            const units: Record<string, number> = {
                B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
            };
            sizeInBytes = parseFloat(sizeMatch[1]) * (units[sizeMatch[2]] ?? 1);
        }

        // rowCount=1  or  rowCount=2.51E+4  or  rowCount=-1 (unknown)
        const rowMatch = inner.match(/rowCount=([\d.E+\-]+)/i);
        let rowCount: number | null = null;
        if (rowMatch) {
            const v = parseFloat(rowMatch[1]);
            if (!isNaN(v) && v >= 0) {
                rowCount = Math.round(v);
            }
        }

        return { rowCount, sizeInBytes, isRuntime };
    }

    return { rowCount: null, sizeInBytes: null, isRuntime: false };
}
