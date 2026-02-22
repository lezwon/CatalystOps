/**
 * Hover provider - clean markdown cards with one-line detail and a quick-fix code block
 */

import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from '../models/constants';

interface FixEntry {
    detail: string;
    fix?: string;
    config?: Record<string, string>;
}

// Keyed by the exact issue title (= diagnostic.message after the message-shortening fix)
const ISSUE_INFO: Record<string, FixEntry> = {

    // ── Plan issues ────────────────────────────────────────────────────────────

    'Broadcast Hash Join': {
        detail: 'Efficient join: the smaller table was broadcast to all executors. No action required.',
    },
    'Broadcast Join → Single Partition Bottleneck': {
        detail: 'After the broadcast join all data is funnelled to one executor via Exchange SinglePartition. Avoid global aggregations (count, sum over all rows) immediately after a broadcast join.',
    },
    'Sort-Merge Join': {
        detail: 'Both inputs are sorted and shuffled across the cluster. If one side is small, force a broadcast join.',
        fix: 'from pyspark.sql.functions import broadcast\nresult = large_df.join(broadcast(small_df), "key")',
        config: { 'spark.sql.autoBroadcastJoinThreshold': '104857600' },
    },
    'Small Side Not Broadcast in Sort-Merge Join': {
        detail: 'One side of this join is small enough to broadcast, but Spark chose sort-merge. Use the broadcast() hint.',
        fix: 'from pyspark.sql.functions import broadcast\nresult = large_df.join(broadcast(small_df), "key")',
        config: { 'spark.sql.autoBroadcastJoinThreshold': '104857600' },
    },
    'Shuffled Hash Join': {
        detail: 'Consider broadcasting the smaller table if it fits in executor memory.',
        fix: 'from pyspark.sql.functions import broadcast\nresult = large_df.join(broadcast(small_df), "key")',
    },
    'Cartesian Product': {
        detail: 'Produces O(n×m) rows — catastrophically expensive. Add an explicit join condition.',
        fix: 'result = df1.join(df2, df1["key"] == df2["key"])  # add join condition',
    },
    'Broadcast Nested Loop Join': {
        detail: 'No join keys — Spark is iterating every row combination. Add join keys to enable hash or sort-merge join.',
        fix: 'result = df1.join(df2, df1["key"] == df2["key"])  # add join key',
    },
    'Shuffle Exchange': {
        detail: 'Data is being redistributed across partitions. Minimise shuffles by reusing partitioned DataFrames or caching before repeated aggregations.',
    },
    'Too Few Shuffle Partitions': {
        detail: 'Very few output partitions concentrate work on few tasks, risking OOM and slow processing.',
        fix: 'spark.conf.set("spark.sql.shuffle.partitions", 200)',
    },
    'Missing Table Statistics': {
        detail: 'Without statistics the optimizer makes suboptimal join and partition decisions.',
        fix: 'spark.sql("ANALYZE TABLE my_table COMPUTE STATISTICS FOR ALL COLUMNS")',
    },
    'Cached Relation Re-Scanned': {
        detail: 'The same cached DataFrame is read multiple times. Restructure to reference it only once.',
    },
    'Cache Will Spill to Disk': {
        detail: 'The cached dataset exceeds cluster memory and will spill to disk, degrading performance.',
        fix: '# Cache only needed columns:\ndf.select("col1", "col2").cache()\n\n# Or use disk-only storage:\nfrom pyspark import StorageLevel\ndf.persist(StorageLevel.DISK_ONLY)',
    },
    'Large Cached Relation': {
        detail: 'Large cache risks spilling to disk. Verify available executor memory or cache a narrower projection.',
        fix: 'df.select("col1", "col2").cache()  # fewer columns = less memory',
    },
    'CSV Format — Use Parquet/Delta': {
        detail: 'CSV disables columnar reads, predicate pushdown, and vectorized execution. Convert to Parquet or Delta.',
        fix: '# Write once as Parquet:\ndf.write.parquet("path/")\ndf = spark.read.parquet("path/")\n\n# Or Delta (supports updates/deletes):\ndf.write.format("delta").save("path/")\ndf = spark.read.format("delta").load("path/")',
    },
    'first() Without Ordering Guarantee': {
        detail: 'first() returns an arbitrary value in distributed execution — result is non-deterministic between runs.',
        fix: '# Deterministic alternative:\ndf.groupBy("key").agg(F.min("col"))\n\n# Or sort first if order matters:\ndf.orderBy("col").groupBy("key").agg(F.first("col"))',
    },
    // ── Local code issues ──────────────────────────────────────────────────────

    'UDF Usage Detected': {
        detail: 'UDFs prevent Catalyst from optimising the query plan and add serialisation overhead.',
        fix: '# Prefer built-in Spark functions:\ndf.withColumn("doubled", F.col("value") * 2)\n\n# Instead of:\nmy_udf = udf(lambda x: x * 2)\ndf.withColumn("doubled", my_udf(F.col("value")))',
    },
    'collect() Usage': {
        detail: 'collect() brings ALL data to the driver — causes OOM on large datasets.',
        fix: '# Limit first:\nsample = df.take(1000)\n\n# Or write to storage:\ndf.write.parquet("output_path")',
    },
    'toPandas() Usage': {
        detail: 'toPandas() collects all data to the driver. Filter or aggregate first.',
        fix: 'pdf = df.limit(10_000).toPandas()  # always limit before toPandas()',
    },
    'Schema Inference': {
        detail: 'Schema inference requires an extra full scan of the data. Provide an explicit schema.',
        fix: 'from pyspark.sql.types import StructType, StructField, StringType, IntegerType\nschema = StructType([StructField("col1", StringType()), StructField("col2", IntegerType())])\nspark.read.schema(schema).csv("path")',
    },
    'Multiple Filter Operations': {
        detail: 'Chained filters can be merged into one for cleaner plans.',
        fix: 'df.filter((F.col("a") > 1) & (F.col("b") < 10))  # single filter',
    },
    'Unnecessary count()': {
        detail: 'count() > 0 triggers a full job just to check emptiness. Use isEmpty() instead.',
        fix: 'if not df.isEmpty(): ...\n# or:\nif len(df.take(1)) > 0: ...',
    },
    'RDD Conversion': {
        detail: 'Converting to RDD loses Catalyst optimisations. Stay in the DataFrame API.',
        fix: 'df.select(...).withColumn(...)  # use DataFrame transformations',
    },
    'coalesce(1) Detected': {
        detail: 'coalesce(1) routes all data through one partition, eliminating parallelism.',
        fix: '# Only for small outputs. For large data keep multiple partitions:\nlarge_df.write.parquet("path")  # multiple files is fine',
    },
    'show() in Production': {
        detail: 'show() triggers computation and should be removed from production pipelines.',
        fix: '# Remove or replace with logging:\nlogger.info(f"Row count: {df.count()}")',
    },
    'Unpersisted DataFrame': {
        detail: 'Cached DataFrame should be unpersisted when done to free executor memory.',
        fix: 'df_cached = df.cache()\n# ... use df_cached ...\ndf_cached.unpersist()  # free memory when done',
    },
    'Cross Join Detected': {
        detail: 'Cross join creates a cartesian product — result size is O(n×m). Add a join condition.',
        fix: 'result = df1.join(df2, df1["key"] == df2["key"])  # add explicit condition',
    },
    'Global orderBy Detected': {
        detail: 'Global orderBy shuffles all data. Use sortWithinPartitions for local sorting.',
        fix: 'df.sortWithinPartitions("column")  # no full shuffle',
    },
    'repartition(1) Detected': {
        detail: 'repartition(1) forces a full shuffle to one partition. Use coalesce(1) (no shuffle).',
        fix: 'df.coalesce(1).write.parquet("path")  # avoids full shuffle',
    },
    'pandas_udf Usage Detected': {
        detail: 'Vectorised UDF is better than regular UDF but still limits some optimisations. Prefer built-in functions.',
        fix: 'df.withColumn("result", F.sqrt(F.col("value")))  # built-in preferred',
    },
    'to_pandas_on_spark() Conversion': {
        detail: 'Use native Spark DataFrame operations for better performance.',
        fix: 'df.groupBy("col").agg(F.mean("value"))  # native Spark',
    },
    'dropDuplicates() Without Subset': {
        detail: 'Without a subset, dropDuplicates() compares ALL columns, which is expensive.',
        fix: 'df.dropDuplicates(["id", "timestamp"])  # specify key columns',
    },
    'dropDuplicates on Streaming DataFrame (Cross-Batch Stateful Dedup)': {
        detail: 'Spark creates a `StreamingDeduplicate` node that remembers every key it has ever seen across all micro-batches (stored in checkpoint state). Any row whose key was already seen in a previous batch is silently dropped — it never reaches your sink.',
        fix: `# Per-batch dedup (no cross-batch state):
def process_batch(batch_df, batch_id):
    batch_df.dropDuplicates(["id"]).write.mode("append").saveAsTable("t")
streaming_df.writeStream.foreachBatch(process_batch).start()

# Time-bounded dedup (state expires):
streaming_df.withWatermark("event_time", "1 hour").dropDuplicates(["id", "event_time"])`,
    },
    'display() in Production Code': {
        detail: 'display() is a notebook function that triggers computation. Remove from production pipelines.',
        fix: 'df.write.parquet("output_path")  # write instead of display',
    },
    'withColumn in Loop': {
        detail: 'withColumn() in a loop creates deeply nested plans causing StackOverflow and poor performance.',
        fix: 'df = df.select([\n    F.upper(F.col(c)).alias(c) if c in columns else F.col(c)\n    for c in df.columns\n])',
    },
    'SQL Injection Risk in spark.sql()': {
        detail: 'F-strings or .format() in spark.sql() enable SQL injection if variables come from user input.',
        fix: 'df.filter(F.col("id") == user_id)  # use DataFrame API\n\n# Or parameterized SQL (Spark 3.4+):\nspark.sql("SELECT * FROM t WHERE id = :id", args={"id": user_id})',
    },
    'Write Without Mode Specified': {
        detail: "Default write mode is 'errorIfExists' — will fail if the target path already exists.",
        fix: 'df.write.mode("overwrite").parquet("path")  # explicit mode',
    },
    'Non-deterministic Operation in UDF': {
        detail: 'Non-deterministic ops in UDFs produce inconsistent results when tasks are retried.',
        fix: 'df.withColumn("noisy", F.col("value") + F.rand())  # use built-in F.rand()',
    },
    "Deprecated DataFrame.append() Usage": {
        detail: 'pandas DataFrame.append() is removed in pandas 2.0.',
        fix: 'df = pd.concat([df, other_df], ignore_index=True)',
    },
    "select('*') Usage": {
        detail: 'Selecting all columns reads unnecessary data. Select only the columns you need.',
        fix: 'df.select("id", "name", "value")  # explicit columns',
    },
    'Table May Lack Statistics': {
        detail: 'Without statistics, the optimizer makes suboptimal join and partition decisions.',
        fix: 'spark.sql("ANALYZE TABLE my_table COMPUTE STATISTICS FOR ALL COLUMNS")',
    },
    'Join Without broadcast()': {
        detail: 'If one side is small, wrapping it in broadcast() avoids an expensive shuffle join.',
        fix: 'from pyspark.sql.functions import broadcast\nresult = large_df.join(broadcast(small_df), "key")',
    },
    'checkpoint() Usage': {
        detail: 'checkpoint() writes the full DataFrame to HDFS/S3 and truncates the lineage graph. This incurs I/O cost every time it runs.',
        fix: '# In-memory persistence (fastest reads):\ndf.cache()\n\n# Local checkpoint (no HDFS write, truncates lineage):\ndf.localCheckpoint()',
    },
    'Same Source Scanned Multiple Times': {
        detail: 'The physical/logical plan shows this table or file is scanned more than once. Each scan triggers separate I/O and compute. Cache after the first read and reuse the result.',
        fix: 'df = spark.table("my_table").cache()\n# or:\ndf = spark.read.parquet("path/").cache()\n\n# Reuse df everywhere instead of reading again',
    },
    'Large DataFrame Cached': {
        detail: 'A large DataFrame is being cached. Caching only the columns you need reduces memory pressure and spill risk.',
        fix: '# Cache only needed columns:\ndf.select("col1", "col2", "col3").cache()\n\n# Unpersist when done:\ndf_cached.unpersist()',
    },
    'Cache Spilling to Disk': {
        detail: 'The cached DataFrame has exceeded executor memory and is spilling to or stored on disk, significantly degrading read performance.',
        fix: '# Option 1 — cache fewer columns:\ndf.select("col1", "col2").cache()\n\n# Option 2 — explicit disk-only (predictable I/O, no OOM):\nfrom pyspark import StorageLevel\ndf.persist(StorageLevel.DISK_ONLY)\n\n# Option 3 — remove cache if recompute is cheap:\ndf.unpersist()',
    },
    'Cache Using Deserialized Java Objects': {
        detail: 'The cache uses deserialized Java objects (default MEMORY_ONLY). This consumes 3-5× more heap than Kryo-serialized storage and causes heavy GC pressure.',
        fix: '# Enable Kryo serializer in Spark config:\nspark.conf.set("spark.serializer", "org.apache.spark.serializer.KryoSerializer")\n\n# Then use serialized storage level:\nfrom pyspark import StorageLevel\ndf.persist(StorageLevel.MEMORY_ONLY_SER)  # ~3-5x smaller than MEMORY_ONLY',
    },
    'Default 200 Shuffle Partitions on Large Data': {
        detail: 'Exchange hashpartitioning is using the default 200 partitions on a large dataset, producing oversized partitions that risk spill and slow task execution.',
        fix: '# Tune for ~200 MB per partition:\nspark.conf.set("spark.sql.shuffle.partitions", 1000)  # adjust to your data size\n\n# Or let AQE tune it automatically (Spark 3.0+):\nspark.conf.set("spark.sql.adaptive.enabled", "true")\nspark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")',
        config: { 'spark.sql.shuffle.partitions': '1000' },
    },
};

export function createHoverProvider(): vscode.HoverProvider {
    return {
        provideHover(
            document: vscode.TextDocument,
            position: vscode.Position,
        ): vscode.Hover | undefined {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            const catalystDiags = diagnostics.filter(d =>
                d.source === DIAGNOSTIC_SOURCE && d.range.contains(position),
            );

            if (catalystDiags.length === 0) { return undefined; }

            const parts: vscode.MarkdownString[] = [];

            for (const diag of catalystDiags) {
                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                md.supportThemeIcons = true;

                const icon = getSeverityIcon(diag.severity);
                md.appendMarkdown(`### ${icon} ${diag.message}\n\n`);

                const info = ISSUE_INFO[diag.message];
                if (info) {
                    md.appendMarkdown(`${info.detail}\n\n`);
                    if (info.fix) {
                        md.appendMarkdown('**Quick fix:**\n');
                        md.appendCodeblock(info.fix, 'python');
                    }
                    if (info.config) {
                        md.appendMarkdown('**Config:**\n');
                        for (const [key, value] of Object.entries(info.config)) {
                            md.appendCodeblock(`spark.conf.set("${key}", "${value}")`, 'python');
                        }
                    }
                }

                parts.push(md);
            }

            return new vscode.Hover(parts);
        },
    };
}

function getSeverityIcon(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error: return '$(error)';
        case vscode.DiagnosticSeverity.Warning: return '$(warning)';
        case vscode.DiagnosticSeverity.Information: return '$(info)';
        default: return '$(lightbulb)';
    }
}
