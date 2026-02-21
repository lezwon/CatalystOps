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

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

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
            const count = (seenFileScanPaths.get(fileScanPath) ?? 0) + 1;
            seenFileScanPaths.set(fileScanPath, count);
            if (count === 2) {
                issues.push({
                    type: 'cache',
                    name: 'RepeatedFileScan',
                    description:
                        `"${fileScanPath}" is scanned more than once in this query plan. ` +
                        'Cache the DataFrame after the first read to avoid repeated I/O:\n' +
                        '  df = spark.read.parquet("...").cache()\n' +
                        'For small DataFrames, also consider broadcast(df) to eliminate the scan entirely.',
                    costPoints: 30,
                    planLine: trimmed,
                });
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
    const m = trimmed.match(/FileScan\s+\w+\s+([\w.]+)\[/i);
    return m ? m[1] : null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Calculate total cost score from plan issues. */
export function calculatePlanCost(issues: PlanIssue[]): number {
    return issues.reduce((total, issue) => total + issue.costPoints, 0);
}

/** Parse plan data from cluster analysis results. Passes cluster info for memory-aware checks. */
export function parsePlanFromResults(results: AnalysisResult[]): PlanIssue[] {
    const allIssues: PlanIssue[] = [];
    for (const result of results) {
        if (result.executionPlan?.physicalPlan) {
            allIssues.push(...parsePlan(result.executionPlan.physicalPlan, result.cluster));
        }
    }
    return allIssues;
}
