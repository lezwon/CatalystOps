package com.catalystops.analysis

/**
 * Parses Spark explain("formatted") output for optimization issues.
 * Ported from vscode/analysis/planParser.ts.
 */

data class PlanIssue(
    val name: String,
    val description: String,
    val costPoints: Int,
    val planLine: String? = null,
    val tableName: String? = null
)

object PlanParser {

    fun parsePlan(planText: String): List<PlanIssue> {
        val issues = mutableListOf<PlanIssue>()
        val lines = planText.split("\n")
        var lastScannedTable: String? = null

        val seenInMemoryKeys = mutableSetOf<String>()
        val seenFileScanPaths = mutableMapOf<String, Int>()
        val seenDedupeKeys = mutableSetOf<String>()

        // AQE plans: skip Initial Plan section when a Final Plan is present
        val initialPlanStart = planText.indexOf("Initial Plan", ignoreCase = true)
            .let { if (it == -1) -1 else planText.lastIndexOf("==", it) }
        val finalPlanOperatorPattern = Regex(
            """FileScan|PhotonScan|\bScan\s+(?:parquet|delta|orc|json|csv)\b|SortMergeJoin|BroadcastHashJoin|BroadcastNestedLoopJoin|Exchange\b|HashAggregate|SortAggregate""",
            RegexOption.IGNORE_CASE
        )
        val hasFinalPlan = if (initialPlanStart > -1) {
            finalPlanOperatorPattern.containsMatchIn(planText.substring(0, initialPlanStart))
        } else false
        var inInitialPlan = false

        for (i in lines.indices) {
            val trimmed = lines[i].trim()

            if (Regex("""==\s*Initial Plan\s*==""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                inInitialPlan = true
            }
            if (inInitialPlan && hasFinalPlan) continue

            // ── Join type detection ────────────────────────────────────────────────

            when {
                Regex("""BroadcastHashJoin|PhotonBroadcastHashJoin""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) -> {
                    issues.add(PlanIssue(
                        name = "BroadcastHashJoin",
                        description = "Broadcast hash join detected (efficient for small tables).",
                        costPoints = 1,
                        planLine = trimmed
                    ))
                    // Check for SinglePartition within next 8 lines
                    for (j in (i + 1)..minOf(i + 7, lines.lastIndex)) {
                        if (Regex("""Exchange\s+SinglePartition""", RegexOption.IGNORE_CASE).containsMatchIn(lines[j])) {
                            issues.add(PlanIssue(
                                name = "BroadcastJoinSinglePartition",
                                description = "BroadcastHashJoin result is collected via Exchange SinglePartition, " +
                                    "sending all data to one executor. This creates a severe bottleneck. " +
                                    "Avoid global scalar aggregations after a broadcast join where possible, " +
                                    "or confirm the final result set is small enough to justify it.",
                                costPoints = 60,
                                planLine = trimmed
                            ))
                            break
                        }
                    }
                }

                Regex("""SortMergeJoin|PhotonSortMergeJoin""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) -> {
                    issues.add(PlanIssue(
                        name = "SortMergeJoin",
                        description = "Sort-merge join requires sorting both inputs and shuffling data across the cluster. " +
                            "If either side is small, force a broadcast join with the broadcast() hint or increase " +
                            "spark.sql.autoBroadcastJoinThreshold.",
                        costPoints = 50,
                        planLine = trimmed
                    ))
                    val segment = lines.slice(i..minOf(i + 19, lines.lastIndex)).joinToString("\n")
                    val smallSide = findSmallSide(segment)
                    if (smallSide != null && smallSide < 200L * 1024 * 1024) {
                        issues.add(PlanIssue(
                            name = "BroadcastableSmallSide",
                            description = "One side of this SortMergeJoin is only ${formatBytes(smallSide)} — " +
                                "small enough to broadcast, but Spark chose a sort-merge join. " +
                                "Use the broadcast() hint: df_large.join(broadcast(df_small), ...) " +
                                "or raise spark.sql.autoBroadcastJoinThreshold above $smallSide.",
                            costPoints = 30,
                            planLine = trimmed
                        ))
                    }
                }

                Regex("""ShuffledHashJoin|PhotonShuffledHashJoin""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) -> {
                    issues.add(PlanIssue(
                        name = "ShuffledHashJoin",
                        description = "Shuffled hash join: consider broadcasting the smaller table if it fits in memory.",
                        costPoints = 30,
                        planLine = trimmed
                    ))
                }

                Regex("""CartesianProduct""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) -> {
                    issues.add(PlanIssue(
                        name = "CartesianProduct",
                        description = "Cartesian product detected! This produces an O(n×m) result set and is extremely expensive. " +
                            "Add a join condition or use a broadcast join instead.",
                        costPoints = 1000,
                        planLine = trimmed
                    ))
                }

                Regex("""BroadcastNestedLoopJoin""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) -> {
                    val isCross = Regex("""\bCross\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)
                    issues.add(PlanIssue(
                        name = if (isCross) "CrossJoin" else "BroadcastNestedLoopJoin",
                        description = if (isCross) {
                            "Cross join (BroadcastNestedLoopJoin Cross) detected — this produces a full cartesian product. " +
                                "Every row from the left side is paired with every row from the right side, resulting in O(n×m) rows. " +
                                "If a join relationship exists, replace with an equi-join: df1.join(df2, \"join_key\"). " +
                                "If intentional, ensure both sides are very small and consider adding .hint(\"broadcast\") explicitly."
                        } else {
                            "Broadcast nested loop join detected. This is expensive for large datasets — " +
                                "add join keys to allow a hash or sort-merge join instead."
                        },
                        costPoints = if (isCross) 500 else 80,
                        planLine = trimmed
                    ))
                }
            }

            // ── Shuffle (Exchange) detection ───────────────────────────────────────

            val isExchange = (Regex("""\bExchange\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) &&
                !Regex("""BroadcastExchange""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) ||
                Regex("""PhotonShuffleExchange(?:Sink|Source)""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)

            if (isExchange) {
                if (Regex("""Exchange\s+SinglePartition\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) &&
                    !seenDedupeKeys.contains("single-partition")) {
                    seenDedupeKeys.add("single-partition")
                    issues.add(PlanIssue(
                        name = "SinglePartitionBottleneck",
                        description = "Exchange SinglePartition detected: all data is being collected to a single executor. " +
                            "This eliminates parallelism and is a severe bottleneck on large datasets. " +
                            "Common causes: global aggregation (no GROUP BY), global window (no PARTITION BY), " +
                            "or a scalar subquery. Add a PARTITION BY / GROUP BY key, or restructure the query " +
                            "to avoid global collection.",
                        costPoints = 65,
                        planLine = trimmed,
                        tableName = lastScannedTable
                    ))
                } else if (!Regex("""Exchange\s+SinglePartition\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                    issues.add(PlanIssue(
                        name = "Exchange",
                        description = "Shuffle exchange: data is being redistributed across partitions.",
                        costPoints = 20,
                        planLine = trimmed
                    ))
                }

                // Too few shuffle partitions
                val partsMatch = Regex("""hashpartitioning\([^)]+,\s*(\d+)\)""", RegexOption.IGNORE_CASE).find(trimmed)
                if (partsMatch != null) {
                    val numParts = partsMatch.groupValues[1].toIntOrNull() ?: 0
                    val nearbyText = lines.slice(maxOf(0, i - 5)..minOf(i + 4, lines.lastIndex)).joinToString("\n")
                    val dataSize = parseSizeBytes(nearbyText)

                    when {
                        numParts <= 1 -> issues.add(PlanIssue(
                            name = "TooFewShufflePartitions",
                            description = "Shuffle is writing to only $numParts partition(s), concentrating all data " +
                                "on a single task. This causes OOM errors and eliminates parallelism. " +
                                "Set spark.conf.set(\"spark.sql.shuffle.partitions\", 200) or call repartition().",
                            costPoints = 50,
                            planLine = trimmed
                        ))
                        numParts < 10 && dataSize != null && dataSize > 500L * 1024 * 1024 -> issues.add(PlanIssue(
                            name = "TooFewShufflePartitions",
                            description = "Only $numParts shuffle partition(s) for ${formatBytes(dataSize)} of data. " +
                                "Each partition will be very large, risking spill and slow processing. " +
                                "Increase spark.sql.shuffle.partitions or call repartition().",
                            costPoints = 35,
                            planLine = trimmed
                        ))
                        numParts == 200 -> {
                            val wideText = lines.slice(maxOf(0, i - 15)..minOf(i + 14, lines.lastIndex)).joinToString("\n")
                            val wideSize = parseSizeBytes(wideText)
                            if (wideSize != null && wideSize > 20L * 1024 * 1024 * 1024) {
                                val avgMB = (wideSize / numParts) / (1024.0 * 1024.0)
                                val optimalParts = Math.ceil(wideSize / (200.0 * 1024 * 1024)).toInt()
                                issues.add(PlanIssue(
                                    name = "DefaultShufflePartitions",
                                    description = "Exchange hashpartitioning uses the default 200 partitions for ${formatBytes(wideSize)} of data " +
                                        "(~${avgMB.toInt()} MB per partition). This is likely under-partitioned — large partitions " +
                                        "cause slow tasks and spill to disk. " +
                                        "Increase to ~$optimalParts partitions (targeting ~200 MB each).",
                                    costPoints = 40,
                                    planLine = trimmed
                                ))
                            }
                        }
                    }
                }
            }

            // ── Table name extraction ──────────────────────────────────────────────

            val fileScanMatch = Regex("""(?:FileScan|PhotonScan)\s+(?:parquet|delta|orc|json|csv)\s+([\w.]+)""", RegexOption.IGNORE_CASE).find(trimmed)
                ?: Regex("""\bScan\s+(?:parquet|delta|orc|json|csv)\s+([\w.]+(?:\.[\w]+)*)""", RegexOption.IGNORE_CASE).find(trimmed)
            val hiveScanMatch = Regex("""HiveTableScan\s+.*?\s+([\w.]+)""", RegexOption.IGNORE_CASE).find(trimmed)
            val scannedTable = fileScanMatch?.groupValues?.get(1) ?: hiveScanMatch?.groupValues?.get(1)
            if (scannedTable != null) lastScannedTable = scannedTable

            // ── Partition pruning ──────────────────────────────────────────────────

            if (Regex("""PartitionFilters:\s*\[\s*\]""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                val tableForFilter = scannedTable ?: lastScannedTable
                if (tableForFilter != null && tableForFilter.contains('.')) {
                    val seenKey = "partition-prune:$tableForFilter"
                    if (!seenDedupeKeys.contains(seenKey)) {
                        seenDedupeKeys.add(seenKey)
                        val shortName = tableForFilter.split('.').last()
                        issues.add(PlanIssue(
                            name = "MissingPartitionFilter",
                            description = "No partition filter is applied to \"$shortName\". " +
                                "If this table is partitioned, every partition will be scanned — " +
                                "add a filter on the partition column (e.g. date, region) to skip irrelevant files. " +
                                "On large partitioned tables this can reduce scan cost by 10–1000×.",
                            costPoints = 60,
                            planLine = trimmed,
                            tableName = tableForFilter
                        ))
                    }
                }
            }

            // ── InMemoryRelation ───────────────────────────────────────────────────

            if (Regex("""InMemoryRelation""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                val colMatch = Regex("""InMemoryRelation\s+\[([^\]]+)\]""").find(trimmed)
                val fp = if (colMatch != null) colMatch.groupValues[1] else trimmed.substring(trimmed.indexOf("InMemoryRelation").coerceAtLeast(0)).take(80)

                if (seenInMemoryKeys.contains(fp)) {
                    issues.add(PlanIssue(
                        name = "CacheRescan",
                        description = "A cached relation is being re-scanned multiple times in this query. " +
                            "This happens when the same cached DataFrame is referenced in multiple branches " +
                            "of the plan. Consider materialising the intermediate result or restructuring " +
                            "the query to read the cache only once.",
                        costPoints = 25,
                        planLine = trimmed
                    ))
                } else {
                    seenInMemoryKeys.add(fp)
                }

                if (Regex("""StorageLevel\s*\(""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                    val hasMemory = Regex("""StorageLevel\s*\([^)]*\bmemory\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)
                    val hasDisk = Regex("""StorageLevel\s*\([^)]*\bdisk\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)

                    if (hasDisk && hasMemory) {
                        issues.add(PlanIssue(
                            name = "CacheDiskSpill",
                            description = "Cached DataFrame is spilling to disk (MEMORY_AND_DISK storage level). " +
                                "The dataset exceeds available executor memory. " +
                                "Cache a narrower projection (.select(...).cache()), " +
                                "increase executor memory, or remove the cache entirely if recompute is cheaper.",
                            costPoints = 70,
                            planLine = trimmed
                        ))
                    } else if (hasDisk && !hasMemory) {
                        issues.add(PlanIssue(
                            name = "CacheDiskSpill",
                            description = "Cached DataFrame uses DISK_ONLY storage — all reads require disk I/O. " +
                                "This can be slower than recomputing from source for simple transformations. " +
                                "Increase executor memory to allow in-memory caching, or remove cache() if reads are infrequent.",
                            costPoints = 50,
                            planLine = trimmed
                        ))
                    }

                    if (Regex("""StorageLevel\s*\([^)]*\bdeserialized\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                        issues.add(PlanIssue(
                            name = "CacheDeserialized",
                            description = "Cached DataFrame uses deserialized Java objects (MEMORY_ONLY default). " +
                                "Deserialized storage consumes 3-5x more heap than Kryo-serialized storage " +
                                "and causes heavy GC pressure on large DataFrames. " +
                                "Enable Kryo and use MEMORY_ONLY_SER to significantly reduce memory usage.",
                            costPoints = 30,
                            planLine = trimmed
                        ))
                    }
                }

                val sizeBytes = parseSizeBytes(trimmed)
                if (sizeBytes != null) {
                    if (sizeBytes > 100L * 1024 * 1024 * 1024) {
                        issues.add(PlanIssue(
                            name = "CacheMemorySpillRisk",
                            description = "Cached relation is ${formatBytes(sizeBytes)} but exceeds estimated cluster " +
                                "storage capacity — data will spill to disk and degrade cache read performance. " +
                                "Options: (1) increase cluster size, (2) cache only needed columns with " +
                                ".select(...).cache(), (3) switch to StorageLevel.DISK_ONLY to avoid OOM.",
                            costPoints = 80,
                            planLine = trimmed
                        ))
                    } else if (sizeBytes > 10L * 1024 * 1024 * 1024) {
                        val isDeserialized = Regex("""deserialized""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)
                        issues.add(PlanIssue(
                            name = "LargeCache",
                            description = "Cached relation is ${formatBytes(sizeBytes)}. " +
                                if (isDeserialized) {
                                    "StorageLevel DESERIALIZED is the most memory-intensive storage level. " +
                                        "For large datasets consider MEMORY_AND_DISK_SER to reduce pressure."
                                } else {
                                    "Verify your cluster has sufficient free executor memory to avoid spilling to disk."
                                },
                            costPoints = 30,
                            planLine = trimmed
                        ))
                    }
                }
            }

            // ── CSV / text format ──────────────────────────────────────────────────

            if (Regex("""(?:FileScan|PhotonScan)\s+(?:csv|text)\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) ||
                Regex("""Format:\s*(?:CSV|Text)\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) ||
                (Regex("""\bScan\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) && Regex("""\.csv\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed))) {
                issues.add(PlanIssue(
                    name = "CsvRead",
                    description = "Reading CSV/text format disables columnar reads, predicate pushdown, and vectorized " +
                        "execution. Convert to Parquet or Delta Lake for significantly faster queries.",
                    costPoints = 40,
                    planLine = trimmed
                ))
            }

            // ── first() aggregation ────────────────────────────────────────────────

            if (Regex("""\bfirst\s*\(""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) &&
                Regex("""(?:HashAggregate|ObjectHashAggregate|SortAggregate)""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                issues.add(PlanIssue(
                    name = "FirstWithoutOrdering",
                    description = "first() aggregation detected. In distributed execution first() returns an arbitrary " +
                        "value — the result is non-deterministic and can change between runs. " +
                        "If a specific value is required, sort first: df.orderBy(\"col\").groupBy(...).agg(first(\"val\")), " +
                        "or use min() / max() if ordering semantics apply.",
                    costPoints = 15,
                    planLine = trimmed
                ))
            }

            // ── SortAggregate ──────────────────────────────────────────────────────

            if (Regex("""\bSortAggregate\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) &&
                !seenDedupeKeys.contains("sort-aggregate")) {
                seenDedupeKeys.add("sort-aggregate")
                issues.add(PlanIssue(
                    name = "SortAggregate",
                    description = "SortAggregate detected instead of HashAggregate. " +
                        "SortAggregate must sort the full input before aggregating — it is significantly slower " +
                        "than HashAggregate and more prone to spilling to disk on large datasets. " +
                        "This is often caused by complex data types (arrays, maps, structs) or certain UDAFs. " +
                        "Simplify aggregation expressions or flatten complex types before aggregating where possible.",
                    costPoints = 35,
                    planLine = trimmed,
                    tableName = lastScannedTable
                ))
            }

            // ── Global Window ──────────────────────────────────────────────────────

            if ((Regex("""\bWindow\s+\[""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) ||
                    Regex("""\bRunningWindowFunction\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) &&
                !seenDedupeKeys.contains("global-window")) {

                var isGlobal = false

                if (Regex("""\bRunningWindowFunction\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed)) {
                    val wsdMatch = Regex("""windowspecdefinition\(([^)]+)\)""", RegexOption.IGNORE_CASE).find(trimmed)
                    if (wsdMatch != null) {
                        val firstArg = wsdMatch.groupValues[1].split(",").firstOrNull()?.trim() ?: ""
                        isGlobal = Regex("""\b(ASC|DESC)\b""", RegexOption.IGNORE_CASE).containsMatchIn(firstArg) ||
                            firstArg.lowercase().startsWith("specifiedwindowframe")
                    } else {
                        val lookahead = lines.slice((i + 1)..minOf(i + 29, lines.lastIndex)).joinToString("\n")
                        isGlobal = Regex("""Exchange\s+SinglePartition\b""", RegexOption.IGNORE_CASE).containsMatchIn(lookahead)
                    }
                } else {
                    val wsdMatch = Regex("""windowspecdefinition\(([^)]+)\)""", RegexOption.IGNORE_CASE).find(trimmed)
                    if (wsdMatch != null) {
                        val firstArg = wsdMatch.groupValues[1].split(",").firstOrNull()?.trim() ?: ""
                        isGlobal = Regex("""\b(ASC|DESC)\b""", RegexOption.IGNORE_CASE).containsMatchIn(firstArg) ||
                            firstArg.lowercase().startsWith("specifiedwindowframe")
                    }
                }

                if (isGlobal) {
                    seenDedupeKeys.add("global-window")
                    issues.add(PlanIssue(
                        name = "GlobalWindow",
                        description = "Window function with no PARTITION BY detected. All data must be collected into a single " +
                            "partition for the window computation — this eliminates parallelism and is a severe bottleneck " +
                            "on large datasets. Add a PARTITION BY column to distribute the work.",
                        costPoints = 70,
                        planLine = trimmed,
                        tableName = lastScannedTable
                    ))
                }
            }

            // ── Union schema mismatch ──────────────────────────────────────────────

            if (Regex("""^\s*\+?[-|: ]*Union\b""", RegexOption.IGNORE_CASE).containsMatchIn(trimmed) &&
                !seenDedupeKeys.contains("union-schema-mismatch")) {
                val lookahead = lines.slice((i + 1)..minOf(i + 24, lines.lastIndex)).joinToString("\n")
                if (Regex("""\w+#\d+L?\s+AS\s+\w+#\d+""", RegexOption.IGNORE_CASE).containsMatchIn(lookahead)) {
                    seenDedupeKeys.add("union-schema-mismatch")
                    issues.add(PlanIssue(
                        name = "UnionSchemaMismatch",
                        description = "Union with implicit column reordering detected. Spark is matching columns by position, " +
                            "not by name — if the schemas differ between DataFrames this silently writes data into " +
                            "the wrong columns (data corruption). Use unionByName() to align columns by name:\n" +
                            "  df1.unionByName(df2)",
                        costPoints = 75,
                        planLine = trimmed
                    ))
                }
            }

            // ── Repeated FileScan ──────────────────────────────────────────────────

            val fileScanPath = extractFileScanPath(trimmed)
            if (fileScanPath != null) {
                val scanSize = parseSizeBytes(trimmed)
                val count = (seenFileScanPaths[fileScanPath] ?: 0) + 1
                seenFileScanPaths[fileScanPath] = count
                if (count == 2) {
                    val isLarge = scanSize != null && scanSize > 512L * 1024 * 1024
                    issues.add(PlanIssue(
                        name = "RepeatedFileScan",
                        description = if (isLarge) {
                            "\"$fileScanPath\" (${formatBytes(scanSize!!)}) is scanned more than once without caching. " +
                                "Reading this large dataset repeatedly is very expensive. Cache after the first read."
                        } else {
                            "\"$fileScanPath\" is scanned more than once without caching. " +
                                "Cache after the first read to avoid repeated I/O."
                        },
                        costPoints = if (isLarge) 60 else 30,
                        planLine = trimmed,
                        tableName = fileScanPath
                    ))
                }
            }
        }

        // ── Missing table statistics ───────────────────────────────────────────────

        val missingStatsIssue = extractMissingStatsIssue(planText)
        if (missingStatsIssue != null) issues.add(missingStatsIssue)

        return issues
    }

    fun parseLogicalPlan(planText: String): List<PlanIssue> {
        if (planText.isEmpty()) return emptyList()
        val issues = mutableListOf<PlanIssue>()
        val seenAliases = mutableMapOf<String, Int>()

        for (line in planText.split("\n")) {
            val trimmed = line.trim()
            val aliasMatch = Regex("""^SubqueryAlias\s+([\w.]+)""", RegexOption.IGNORE_CASE).find(trimmed) ?: continue
            val name = aliasMatch.groupValues[1]
            if (name.startsWith("__") || name == "spark_catalog") continue
            val count = (seenAliases[name] ?: 0) + 1
            seenAliases[name] = count
            if (count == 2) {
                val shortName = name.split('.').last()
                issues.add(PlanIssue(
                    name = "RepeatedTableScan",
                    description = "\"$shortName\" is scanned multiple times without caching. " +
                        "Each reference triggers a separate storage read. Cache after the first read:\n" +
                        "  $shortName = spark.table(\"$name\").cache()\n" +
                        "  # Reuse the cached variable instead of re-reading \"$name\"",
                    costPoints = 40,
                    planLine = trimmed,
                    tableName = name
                ))
            }
        }
        return issues
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private fun extractMissingStatsIssue(planText: String): PlanIssue? {
        val sectionMatch = Regex("""==\s*Optimizer Statistics\s*==\s*([\s\S]*?)(?:(?:==\s*\w)|$)""", RegexOption.IGNORE_CASE).find(planText) ?: return null
        val section = sectionMatch.groupValues[1]
        val missingTables = mutableSetOf<String>()

        // Format 1: missing = table1, table2
        for (line in section.split("\n")) {
            val m = Regex("""missing\s*=\s*(.+)""", RegexOption.IGNORE_CASE).find(line) ?: continue
            m.groupValues[1].split(",").map { it.trim() }.filter { it.isNotEmpty() }.forEach { missingTables.add(it) }
        }

        // Format 2: | tablename | missing | missing |
        if (missingTables.isEmpty()) {
            for (line in section.split("\n")) {
                if (!Regex("""\|\s*missing\s*\|""", RegexOption.IGNORE_CASE).containsMatchIn(line)) continue
                val namePart = Regex("""\|\s*([\w.]+)\s*\|""").find(line) ?: continue
                missingTables.add(namePart.groupValues[1])
            }
        }

        // Format 3: Statistics: Not Available
        if (missingTables.isEmpty()) {
            for (line in section.split("\n")) {
                if (!Regex("""Statistics:\s*Not Available""", RegexOption.IGNORE_CASE).containsMatchIn(line)) continue
                val relMatch = Regex("""Relation:\s*([\w.]+)""", RegexOption.IGNORE_CASE).find(line) ?: continue
                missingTables.add(relMatch.groupValues[1])
            }
        }

        if (missingTables.isEmpty()) return null

        val tableList = missingTables.joinToString(", ")
        val analyzeStmts = missingTables.joinToString("\n") { "ANALYZE TABLE $it COMPUTE STATISTICS FOR ALL COLUMNS;" }

        return PlanIssue(
            name = "MissingTableStatistics",
            description = "Optimizer statistics are missing for: $tableList. " +
                "Without row counts and column statistics, the query optimizer cannot accurately estimate " +
                "join order, broadcast thresholds, or shuffle partition sizes — leading to suboptimal plans. Run:\n" +
                analyzeStmts,
            costPoints = 50,
            tableName = missingTables.first()
        )
    }

    private fun parseSizeBytes(text: String): Long? {
        val m = Regex("""sizeInBytes=([\d.]+)\s*(B|KiB|MiB|GiB|TiB)""", RegexOption.IGNORE_CASE).find(text) ?: return null
        val value = m.groupValues[1].toDoubleOrNull() ?: return null
        val unit = m.groupValues[2].lowercase()
        val factor = when (unit) {
            "b" -> 1L
            "kib" -> 1024L
            "mib" -> 1024L * 1024
            "gib" -> 1024L * 1024 * 1024
            "tib" -> 1024L * 1024 * 1024 * 1024
            else -> 1L
        }
        return (value * factor).toLong()
    }

    private fun formatBytes(bytes: Long): String {
        val tib = 1024L * 1024 * 1024 * 1024
        val gib = 1024L * 1024 * 1024
        val mib = 1024L * 1024
        val kib = 1024L
        return when {
            bytes >= tib -> String.format("%.1f TiB", bytes.toDouble() / tib)
            bytes >= gib -> String.format("%.1f GiB", bytes.toDouble() / gib)
            bytes >= mib -> String.format("%.1f MiB", bytes.toDouble() / mib)
            bytes >= kib -> String.format("%.1f KiB", bytes.toDouble() / kib)
            else -> "$bytes B"
        }
    }

    private fun findSmallSide(segment: String): Long? {
        val sizes = mutableListOf<Long>()
        val re = Regex("""sizeInBytes=([\d.]+)\s*(B|KiB|MiB|GiB|TiB)""", RegexOption.IGNORE_CASE)
        for (m in re.findAll(segment)) {
            val value = m.groupValues[1].toDoubleOrNull() ?: continue
            val unit = m.groupValues[2].lowercase()
            val factor = when (unit) {
                "b" -> 1L; "kib" -> 1024L; "mib" -> 1024L * 1024
                "gib" -> 1024L * 1024 * 1024; "tib" -> 1024L * 1024 * 1024 * 1024
                else -> 1L
            }
            sizes.add((value * factor).toLong())
        }
        return if (sizes.size >= 2) sizes.min() else null
    }

    private fun extractFileScanPath(trimmed: String): String? {
        Regex("""(?:FileScan|PhotonScan)\s+\w+\s+([\w.]+)\s*\[""", RegexOption.IGNORE_CASE).find(trimmed)?.let {
            return it.groupValues[1]
        }
        Regex("""\bScan\s+(?:parquet|delta|orc|json|csv)\s+([\w.]+)""", RegexOption.IGNORE_CASE).find(trimmed)?.let {
            return it.groupValues[1]
        }
        Regex("""(?:FileScan|PhotonScan)\s+\w+\s+\[([^\[\]]+)\]""", RegexOption.IGNORE_CASE).find(trimmed)?.let {
            val first = it.groupValues[1].split(",").first().trim().replace(Regex("""^file:""", RegexOption.IGNORE_CASE), "")
            val parts = first.replace("\\", "/").split("/").filter { p -> p.isNotEmpty() }
            return if (parts.size >= 2) parts.takeLast(2).joinToString("/") else first
        }
        return null
    }
}
