/**
 * Plan Parser - Parses explain("formatted") output for join types, shuffles, and other issues.
 */

import { AnalysisResult, ClusterInfo } from '../models/types';

export interface PlanIssue {
    type: 'join' | 'shuffle' | 'statistics' | 'pushdown' | 'cache' | 'format' | 'partition' | 'aggregation' | 'window' | 'union';
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
    const seenDedupeKeys = new Set<string>();

    // AQE plans contain both "== Final Plan ==" and "== Initial Plan ==" sections.
    // FileScan nodes appear in both, which causes false-positive RepeatedFileScan.
    //
    // Skip the Initial Plan section only when there is real operator content (scans, joins,
    // exchanges, aggregates) before the == Initial Plan == marker — this means a resolved final
    // plan is present. If the plan only has a wrapper node (AdaptiveSparkPlan) before the marker,
    // or no Initial Plan marker at all, treat the Initial Plan as the real plan to analyse.
    const initialPlanStart = planText.search(/==\s*Initial Plan\s*==/i);
    const hasFinalPlan = initialPlanStart > -1
        ? /(?:FileScan|PhotonScan|\bScan\s+(?:parquet|delta|orc|json|csv)\b|SortMergeJoin|BroadcastHashJoin|BroadcastNestedLoopJoin|Exchange\b|HashAggregate|SortAggregate)/i
            .test(planText.substring(0, initialPlanStart))
        : false;
    let inInitialPlan = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (/==\s*Initial Plan\s*==/i.test(trimmed)) { inInitialPlan = true; }
        if (inInitialPlan && hasFinalPlan) { continue; }

        // ── Join type detection ────────────────────────────────────────────────

        if (/BroadcastHashJoin/i.test(trimmed) || /PhotonBroadcastHashJoin/i.test(trimmed)) {
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

        } else if (/SortMergeJoin/i.test(trimmed) || /PhotonSortMergeJoin/i.test(trimmed)) {
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

        } else if (/ShuffledHashJoin/i.test(trimmed) || /PhotonShuffledHashJoin/i.test(trimmed)) {
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
            const isCross = /\bCross\b/i.test(trimmed);
            issues.push({
                type: 'join',
                name: isCross ? 'CrossJoin' : 'BroadcastNestedLoopJoin',
                description: isCross
                    ? 'Cross join (BroadcastNestedLoopJoin Cross) detected — this produces a full cartesian product. ' +
                      'Every row from the left side is paired with every row from the right side, resulting in O(n×m) rows. ' +
                      'If a join relationship exists, replace with an equi-join: df1.join(df2, "join_key"). ' +
                      'If intentional, ensure both sides are very small and consider adding .hint("broadcast") explicitly.'
                    : 'Broadcast nested loop join detected. This is expensive for large datasets — ' +
                      'add join keys to allow a hash or sort-merge join instead.',
                costPoints: isCross ? 500 : 80,
                planLine: trimmed,
            });
        }

        // ── Shuffle (Exchange) detection ───────────────────────────────────────

        if ((/\bExchange\b/i.test(trimmed) && !/BroadcastExchange/i.test(trimmed)) ||
            /PhotonShuffleExchange(?:Sink|Source)/i.test(trimmed)) {

            if (/Exchange\s+SinglePartition\b/i.test(trimmed) && !seenDedupeKeys.has('single-partition')) {
                // SinglePartition forces all data to one executor — major bottleneck.
                // Only emit once per plan; often caused by a global aggregate or global window.
                seenDedupeKeys.add('single-partition');
                issues.push({
                    type: 'shuffle',
                    name: 'SinglePartitionBottleneck',
                    description:
                        'Exchange SinglePartition detected: all data is being collected to a single executor. ' +
                        'This eliminates parallelism and is a severe bottleneck on large datasets. ' +
                        'Common causes: global aggregation (no GROUP BY), global window (no PARTITION BY), ' +
                        'or a scalar subquery. Add a PARTITION BY / GROUP BY key, or restructure the query ' +
                        'to avoid global collection.',
                    costPoints: 65,
                    planLine: trimmed,
                });
            } else if (!/Exchange\s+SinglePartition\b/i.test(trimmed)) {
                issues.push({
                    type: 'shuffle',
                    name: 'Exchange',
                    description: 'Shuffle exchange: data is being redistributed across partitions.',
                    costPoints: 20,
                    planLine: trimmed,
                });
            }

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

        // ── Table name extraction (used by RepeatedFileScan and other detectors) ─

        const fileScanMatch = trimmed.match(/(?:FileScan|PhotonScan)\s+(?:parquet|delta|orc|json|csv)\s+([\w.]+)/i)
            || trimmed.match(/\bScan\s+(?:parquet|delta|orc|json|csv)\s+([\w.]+(?:\.[\w]+)*)/i);
        const hiveScanMatch = trimmed.match(/HiveTableScan\s+.*?\s+([\w.]+)/i);
        const scannedTable = fileScanMatch?.[1] || hiveScanMatch?.[1];
        if (scannedTable) {
            lastScannedTable = scannedTable;
        }

        // ── Partition pruning: PartitionFilters: [] on a named table scan ─────
        // An empty PartitionFilters on a qualified table (schema.table or catalog.schema.table)
        // means Spark is reading every partition — no filter was pushed to the storage layer.
        // Only flag qualified table names (not raw paths) to reduce false positives on
        // non-partitioned tables.

        if (/PartitionFilters:\s*\[\s*\]/i.test(trimmed)) {
            // Associate with the table seen on this line (non-formatted explain) or the most
            // recent FileScan line (formatted explain where PartitionFilters is on its own line).
            const tableForFilter = scannedTable ?? lastScannedTable;
            if (tableForFilter && tableForFilter.includes('.')) {
                const seenKey = `partition-prune:${tableForFilter}`;
                if (!seenDedupeKeys.has(seenKey)) {
                    seenDedupeKeys.add(seenKey);
                    const shortName = tableForFilter.split('.').slice(-1)[0];
                    issues.push({
                        type: 'pushdown',
                        name: 'MissingPartitionFilter',
                        description:
                            `No partition filter is applied to "${shortName}". ` +
                            'If this table is partitioned, every partition will be scanned — ' +
                            'add a filter on the partition column (e.g. date, region) to skip irrelevant files. ' +
                            'On large partitioned tables this can reduce scan cost by 10–1000×.',
                        costPoints: 60,
                        planLine: trimmed,
                        tableName: tableForFilter,
                    });
                }
            }
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

        if (/(?:FileScan|PhotonScan)\s+(csv|text)\b/i.test(trimmed) ||
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

        // ── SortAggregate (spill risk, no hash aggregation) ───────────────────
        // SortAggregate is chosen when data types don't support hash-based aggregation
        // (e.g. complex types, certain UDAFs). It requires sorting the full input —
        // much slower than HashAggregate and prone to spill on large datasets.

        if (/\bSortAggregate\b/i.test(trimmed) && !seenDedupeKeys.has('sort-aggregate')) {
            seenDedupeKeys.add('sort-aggregate');
            issues.push({
                type: 'aggregation',
                name: 'SortAggregate',
                description:
                    'SortAggregate detected instead of HashAggregate. ' +
                    'SortAggregate must sort the full input before aggregating — it is significantly slower ' +
                    'than HashAggregate and more prone to spilling to disk on large datasets. ' +
                    'This is often caused by complex data types (arrays, maps, structs) or certain UDAFs. ' +
                    'Simplify aggregation expressions or flatten complex types before aggregating where possible.',
                costPoints: 35,
                planLine: trimmed,
            });
        }

        // ── Global Window (no PARTITION BY) ───────────────────────────────────
        // Detect Window operators whose windowspecdefinition has no partition columns.
        // In Spark's plan, a partitioned window looks like:
        //   windowspecdefinition(partition_col, order_col ASC NULLS LAST, specifiedwindowframe(...))
        // A global window starts directly with an ordering spec or the frame:
        //   windowspecdefinition(order_col ASC NULLS LAST, specifiedwindowframe(...))

        if (/\bWindow\s+\[/i.test(trimmed) || /\bRunningWindowFunction\b/i.test(trimmed)) {
            let isGlobal = false;

            if (/\bRunningWindowFunction\b/i.test(trimmed)) {
                // RunningWindowFunction computes over pre-sorted data. Check windowspecdefinition
                // on this line for partition columns; if absent, look ahead for Exchange SinglePartition
                // which is Spark's signal that all data must be collected to one executor (global window).
                const wsdMatch = trimmed.match(/windowspecdefinition\(([^)]+)\)/i);
                if (wsdMatch) {
                    const firstArg = wsdMatch[1].split(',')[0].trim();
                    isGlobal = /\b(ASC|DESC)\b/i.test(firstArg) || /^specifiedwindowframe/i.test(firstArg);
                } else {
                    // No windowspecdefinition on this line — look ahead within 30 lines for SinglePartition.
                    const lookahead = lines.slice(i + 1, Math.min(i + 30, lines.length)).join('\n');
                    isGlobal = /Exchange\s+SinglePartition\b/i.test(lookahead);
                }
            } else {
                const wsdMatch = trimmed.match(/windowspecdefinition\(([^)]+)\)/i);
                if (wsdMatch) {
                    const firstArg = wsdMatch[1].split(',')[0].trim();
                    // If the first argument contains ASC/DESC it's an ordering spec, not a partition column
                    isGlobal = /\b(ASC|DESC)\b/i.test(firstArg) || /^specifiedwindowframe/i.test(firstArg);
                }
            }

            if (isGlobal && !seenDedupeKeys.has('global-window')) {
                seenDedupeKeys.add('global-window');
                issues.push({
                    type: 'window',
                    name: 'GlobalWindow',
                    description:
                        'Window function with no PARTITION BY detected. All data must be collected into a single ' +
                        'partition for the window computation — this eliminates parallelism and is a severe bottleneck ' +
                        'on large datasets. Add a PARTITION BY column to distribute the work:\n' +
                        '  from pyspark.sql.window import Window\n' +
                        '  w = Window.partitionBy("user_id").orderBy("event_time")\n' +
                        '  df.withColumn("rn", row_number().over(w))',
                    costPoints: 70,
                    planLine: trimmed,
                });
            }
        }

        // ── Union schema mismatch → suggest unionByName ───────────────────────
        // When df1.union(df2) is called with different column orders, Spark wraps one
        // side in a Project that reorders columns (e.g. col2#5 AS col1#6). This is
        // silent data corruption — col values end up in the wrong fields.
        // Signal: Union node followed by a Project with column aliasing (x AS y).

        if (/^\s*\+?[-|: ]*Union\b/i.test(trimmed) && !seenDedupeKeys.has('union-schema-mismatch')) {
            const lookahead = lines.slice(i + 1, Math.min(i + 25, lines.length)).join('\n');
            // Column aliasing: an attribute ref followed by AS and another ref
            if (/\w+#\d+L?\s+AS\s+\w+#\d+/i.test(lookahead)) {
                seenDedupeKeys.add('union-schema-mismatch');
                issues.push({
                    type: 'union',
                    name: 'UnionSchemaMismatch',
                    description:
                        'Union with implicit column reordering detected. Spark is matching columns by position, ' +
                        'not by name — if the schemas differ between DataFrames this silently writes data into ' +
                        'the wrong columns (data corruption). Use unionByName() to align columns by name:\n' +
                        '  df1.unionByName(df2)\n' +
                        '  # To handle extra columns in either side:\n' +
                        '  df1.unionByName(df2, allowMissingColumns=True)',
                    costPoints: 75,
                    planLine: trimmed,
                });
            }
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

    // ── Optimizer Statistics: missing table stats ──────────────────────────────
    // Parse the "== Optimizer Statistics ==" section for tables without stats.
    const missingStatsIssue = extractMissingStatsIssue(planText);
    if (missingStatsIssue) { issues.push(missingStatsIssue); }

    return issues;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract a MissingTableStatistics issue from the "== Optimizer Statistics ==" section.
 * Handles two common formats:
 *   - `missing = table1, table2, table3`  (Databricks explain output)
 *   - Row-based table where values show "missing" or "Statistics: Not Available"
 */
function extractMissingStatsIssue(planText: string): PlanIssue | null {
    // Locate the section — it ends at the next == section or EOF
    const sectionMatch = planText.match(/==\s*Optimizer Statistics\s*==\s*([\s\S]*?)(?:(?:==\s*\w)|$)/i);
    if (!sectionMatch) { return null; }

    const section = sectionMatch[1];
    const missingTables = new Set<string>();

    // Format 1: `missing = table1, table2` (Databricks formatted explain)
    for (const line of section.split('\n')) {
        const m = line.match(/missing\s*=\s*(.+)/i);
        if (m) {
            m[1].split(',').map(t => t.trim()).filter(Boolean).forEach(t => missingTables.add(t));
        }
    }

    // Format 2: table rows with "missing" values (tabular output)
    // Match lines like: | customer      | missing | missing |
    if (missingTables.size === 0) {
        for (const line of section.split('\n')) {
            if (/\|\s*missing\s*\|/i.test(line)) {
                const namePart = line.match(/\|\s*([\w.]+)\s*\|/);
                if (namePart) { missingTables.add(namePart[1]); }
            }
        }
    }

    // Format 3: "Relation: ... Statistics: Not Available"
    if (missingTables.size === 0) {
        for (const line of section.split('\n')) {
            if (/Statistics:\s*Not Available/i.test(line)) {
                const relMatch = line.match(/Relation:\s*([\w.]+)/i);
                if (relMatch) { missingTables.add(relMatch[1]); }
            }
        }
    }

    if (missingTables.size === 0) { return null; }

    const tableList = Array.from(missingTables).join(', ');
    const analyzeStmts = Array.from(missingTables)
        .map(t => `ANALYZE TABLE ${t} COMPUTE STATISTICS FOR ALL COLUMNS;`)
        .join('\n');

    return {
        type: 'statistics',
        name: 'MissingTableStatistics',
        description:
            `Optimizer statistics are missing for: ${tableList}. ` +
            'Without row counts and column statistics, the query optimizer cannot accurately estimate ' +
            'join order, broadcast thresholds, or shuffle partition sizes — leading to suboptimal plans. Run:\n' +
            analyzeStmts,
        costPoints: 50,
        tableName: Array.from(missingTables)[0],
    };
}

/** Parse a "sizeInBytes=X Unit" string from plan text into bytes. */
function parseSizeBytes(text: string): number | null {
    // Matches both Statistics(sizeInBytes=X Unit) and Statistics: sizeInBytes=X Unit
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
    // Format 1: FileScan/PhotonScan parquet schema.table[columns...]
    const tableMatch = trimmed.match(/(?:FileScan|PhotonScan)\s+\w+\s+([\w.]+)\s*\[/i);
    if (tableMatch) { return tableMatch[1]; }

    // Format 2: AQE numbered format — "Scan parquet schema.table (N)" or "*(N) Scan parquet schema.table"
    const aqeScanMatch = trimmed.match(/\bScan\s+(?:parquet|delta|orc|json|csv)\s+([\w.]+)/i);
    if (aqeScanMatch) { return aqeScanMatch[1]; }

    // Format 3: FileScan csv [/path/to/file.csv, ...][columns...]
    const pathMatch = trimmed.match(/(?:FileScan|PhotonScan)\s+\w+\s+\[([^[\]]+)\]/i);
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
                name: 'RepeatedTableScan',
                description:
                    `"${shortName}" is scanned multiple times without caching. ` +
                    'Each reference triggers a separate storage read. Cache after the first read:\n' +
                    `  ${shortName} = spark.table("${name}").cache()\n` +
                    `  # Reuse the cached variable instead of re-reading "${name}"`,
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
 * Detect tables/files scanned in more than one DataFrame's physical plan.
 *
 * Within a single plan, Spark may scan the same table twice if the same
 * DataFrame is referenced in multiple branches — that is caught by
 * seenFileScanPaths inside parsePlan.
 *
 * This function detects the CROSS-DATAFRAME case: the same table appearing
 * in two or more separate DataFrames' physical plans, indicating the data is
 * read from storage multiple times with no caching in between.
 */
function detectCrossPlanRepeatedScans(results: AnalysisResult[]): PlanIssue[] {
    // path → { dfCount, maxSizeBytes, dfNames }
    const scanInfo = new Map<string, { dfCount: number; maxSizeBytes: number; dfNames: string[] }>();

    for (const result of results) {
        if (!result.executionPlan?.physicalPlan) { continue; }
        const lines = result.executionPlan.physicalPlan.split('\n');

        const planTxt = result.executionPlan.physicalPlan;
        const initIdx = planTxt.search(/==\s*Initial Plan\s*==/i);
        const hasFinalPlanLocal = initIdx > -1
            ? /(?:FileScan|PhotonScan|\bScan\s+(?:parquet|delta|orc|json|csv)\b|SortMergeJoin|BroadcastHashJoin|Exchange\b|HashAggregate|SortAggregate)/i
                .test(planTxt.substring(0, initIdx))
            : false;
        let inInitialPlan = false;
        const seenInThisPlan = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (/==\s*Initial Plan\s*==/i.test(trimmed)) { inInitialPlan = true; }
            if (inInitialPlan && hasFinalPlanLocal) { continue; }

            const path = extractFileScanPath(trimmed);
            if (!path || seenInThisPlan.has(path)) { continue; }
            seenInThisPlan.add(path);

            // Look for sizeInBytes on this line or the next 2 (Statistics may follow the scan node)
            const window = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
            const sizeBytes = parseSizeBytes(window) ?? 0;

            const entry = scanInfo.get(path) ?? { dfCount: 0, maxSizeBytes: 0, dfNames: [] };
            entry.dfCount++;
            entry.maxSizeBytes = Math.max(entry.maxSizeBytes, sizeBytes);
            if (result.dataframeName) { entry.dfNames.push(result.dataframeName); }
            scanInfo.set(path, entry);
        }
    }

    const issues: PlanIssue[] = [];
    for (const [path, { dfCount, maxSizeBytes, dfNames }] of scanInfo) {
        if (dfCount < 2) { continue; }

        const isLarge = maxSizeBytes > 512 * 1024 * 1024;
        const shortName = path.split('.').slice(-1)[0];
        const sizeStr = maxSizeBytes > 0 ? ` (${formatBytes(maxSizeBytes)})` : '';
        const dfList = dfNames.length > 0
            ? ` across DataFrames: ${dfNames.join(', ')}`
            : ` across ${dfCount} DataFrames`;

        issues.push({
            type: 'cache',
            name: 'RepeatedFileScan',
            description: isLarge
                ? `"${shortName}"${sizeStr} is read without caching${dfList}. ` +
                  'Each read triggers a full separate storage scan — very expensive for large tables. ' +
                  'Cache after the first read and reuse the cached DataFrame:\n' +
                  `  ${dfNames[0] ?? 'df'} = spark.table("${shortName}").cache()\n` +
                  '  # reuse the cached variable instead of reading again'
                : `"${shortName}" is read${dfList} without caching. ` +
                  'Cache after the first read to avoid repeated I/O.',
            costPoints: isLarge ? 80 : 40,
            tableName: path,
        });
    }
    return issues;
}

/**
 * Parse plan data from cluster analysis results.
 * Analyses both physical plan (for FileScan, caches, joins) and
 * analyzed logical plan (for repeated table reads — cleaner table names).
 * Also detects cross-DataFrame repeated scans of the same table/file.
 */
export function parsePlanFromResults(results: AnalysisResult[]): PlanIssue[] {
    const allIssues: PlanIssue[] = [];
    for (const result of results) {
        if (result.executionPlan?.physicalPlan) {
            allIssues.push(...parsePlan(result.executionPlan.physicalPlan, result.cluster));
        }
        // Logical plan gives cleaner table names for repeated-read detection.
        if (result.executionPlan?.logicalPlan) {
            allIssues.push(...parseLogicalPlan(result.executionPlan.logicalPlan));
        }
    }

    // Cross-DataFrame: detect tables read in multiple DataFrames without caching.
    // This is separate from within-plan repeated scans (handled by seenFileScanPaths).
    allIssues.push(...detectCrossPlanRepeatedScans(results));

    // Deduplicate: use "name:tableName" as the key so different tables each get
    // their own issue entry. For issues without a tableName (e.g. Exchange),
    // deduplicate by name alone. Prefer entries with a tableName when merging.
    const seen = new Map<string, PlanIssue>();
    for (const issue of allIssues) {
        const key = issue.tableName ? `${issue.name}:${issue.tableName}` : issue.name;
        const existing = seen.get(key);
        if (!existing || (!existing.tableName && issue.tableName)) {
            seen.set(key, issue);
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
