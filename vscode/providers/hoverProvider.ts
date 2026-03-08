/**
 * Hover provider - clean markdown cards with one-line detail and a quick-fix code block
 */

import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from '../models/constants';
import { extractStructTypeSchemas, extractDdlSchemas } from '../analysis/schemaExtractor';
import { buildDfSchemaMap, schemaAtLine } from '../analysis/schemaTracker';

interface FixEntry {
    detail: string;
    fix?: string;
    config?: Record<string, string>;
}

// Fallback for dynamic titles — tested in order, first match wins.
const ISSUE_INFO_BY_PATTERN: Array<{ pattern: RegExp; entry: FixEntry }> = [
    {
        // CODE_REPRO_001: '"varName" scanned N× — consider caching'
        pattern: / scanned \d+× — consider caching$/,
        entry: {
            detail: 'This source DataFrame is read multiple times without `.cache()` or `.persist()`. Each use triggers a full re-scan of the underlying data — expensive on large datasets. Cache immediately after the first read and reuse the result.',
            fix: 'df = spark.read.parquet("path").cache()  # materialise once\n\n# Reuse df everywhere instead of reading the source again',
        },
    },
    {
        // CODE_FLOAT_FINANCIAL_001: 'FLOAT/DOUBLE for financial column "col" — use DECIMAL instead'
        pattern: /^FLOAT\/DOUBLE for financial column /,
        entry: {
            detail: '`FloatType` and `DoubleType` use binary floating-point and cannot exactly represent most decimal fractions, causing silent rounding errors in financial calculations (e.g. `0.1 + 0.2 ≠ 0.3`). Use `DecimalType` for all monetary values.',
            fix: `# Instead of:
StructField("amount", FloatType())   # binary float — imprecise

# Use:
StructField("amount", DecimalType(18, 2))  # exact decimal

# In SQL DDL:
amount DECIMAL(18, 2)`,
        },
    },
    {
        // SCHEMA_ALIGN_001: dynamic title with column name
        pattern: /column order mismatch|schema.*align/i,
        entry: {
            detail: 'These DataFrames have the same column names but in a different order. ' +
                'Positional operations — `union()`, `intersect()`, `except()`, `subtract()` — match ' +
                'rows by column **position**, not name. Mismatched ordering silently puts values in ' +
                'the wrong columns.',
            fix: '# Reorder the later DataFrame to match the first:\ndf2 = df2.select("col1", "col2", "col3")\n\n# Or use unionByName() which ignores column order:\nresult = df1.unionByName(df2)',
        },
    },
];

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
    'Join Without broadcast()': {
        detail: 'If one side is small, wrapping it in broadcast() avoids an expensive shuffle join.',
        fix: 'from pyspark.sql.functions import broadcast\nresult = large_df.join(broadcast(small_df), "key")',
    },
    'checkpoint() Usage': {
        detail: 'checkpoint() writes the full DataFrame to HDFS/S3 and truncates the lineage graph. This incurs I/O cost every time it runs.',
        fix: '# In-memory persistence (fastest reads):\ndf.cache()\n\n# Local checkpoint (no HDFS write, truncates lineage):\ndf.localCheckpoint()',
    },
    'union() Matches by Column Position, Not Name': {
        detail: 'union() combines DataFrames by column position. If schemas have a different column order, values land in the wrong columns silently. Use unionByName() to merge by name.',
        fix: '# Safe name-based union:\nresult = df1.unionByName(df2)\n\n# If column sets may differ:\nresult = df1.unionByName(df2, allowMissingColumns=True)',
    },
    'intersect() / intersectAll() Match by Column Position': {
        detail: 'intersect() compares rows by column position. A different column order between the DataFrames will silently compare wrong pairs of columns.',
        fix: '# Align column order before intersecting:\ncols = df1.columns\nresult = df1.intersect(df2.select(cols))',
    },
    'except() / exceptAll() / subtract() Match by Column Position': {
        detail: 'except(), exceptAll(), and subtract() compare rows by column position. A column order difference silently produces wrong results.',
        fix: '# Align column order before subtracting:\ncols = df1.columns\nresult = df1.subtract(df2.select(cols))',
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

    // ── Rules added in 0.6.0 ──────────────────────────────────────────────────

    'No ANALYZE TABLE after overwrite — optimizer may lack statistics': {
        detail: 'After overwriting a table, column statistics are stale or absent. Without statistics Spark cannot accurately estimate join sizes, choose broadcast thresholds, or prune partitions effectively.',
        fix: `df.write.mode("overwrite").saveAsTable("my_table")
spark.sql("ANALYZE TABLE my_table COMPUTE STATISTICS FOR ALL COLUMNS")`,
    },
    'MERGE without Deletion Vectors — enable for faster MERGE performance': {
        detail: 'Without Deletion Vectors, every MERGE that deletes or updates rows must physically rewrite the affected data files. Deletion Vectors convert these to cheap soft-deletes — often 5–10× faster on update-heavy workloads.',
        fix: `spark.sql("""
    ALTER TABLE my_table
    SET TBLPROPERTIES ('delta.enableDeletionVectors' = 'true')
""")`,
    },
    'MERGE without Row-Level Concurrency — enable for concurrent MERGE support': {
        detail: 'Without Row-Level Concurrency, concurrent MERGEs on the same table conflict at the file level, causing retries or failures. Enabling it (alongside Deletion Vectors) allows concurrent MERGEs on different rows to succeed without blocking.',
        fix: `spark.sql("""
    ALTER TABLE my_table
    SET TBLPROPERTIES (
        'delta.enableDeletionVectors' = 'true',
        'delta.enableRowLevelConcurrency' = 'true'
    )
""")`,
    },
    'Auto Loader stream without maxBytesPerTrigger — no backlog protection': {
        detail: 'Without `maxBytesPerTrigger`, Auto Loader processes all available files in one micro-batch when a backlog exists (first run or after downtime). This can cause executor OOM errors. Cap the data volume per batch.',
        fix: `stream = (spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("maxBytesPerTrigger", "100m")  # cap per batch (100–500 MB is typical)
    .load(path))`,
    },
    'Stateful streaming without RocksDB — consider enabling for large state': {
        detail: 'The default in-memory state store holds all state in executor heap. For large state (> 10 GB or > 100M keys), heap fills up causing OOM. RocksDB spills to local disk and supports much larger state with minimal overhead.',
        fix: `spark.conf.set(
    "spark.sql.streaming.stateStore.providerClass",
    "com.databricks.sql.streaming.state.RocksDBStateProvider"
)`,
    },
    'Streaming query has no .trigger() — continuous micro-batches': {
        detail: 'Without `.trigger()`, Spark runs micro-batches as fast as possible — excessive cloud storage listing, high compute costs, unpredictable latency. Set an interval matching your SLA (rule of thumb: SLA ÷ 3). Use `availableNow=True` for cheapest batch-style runs.',
        fix: `# Fixed interval:
df.writeStream \\
    .trigger(processingTime="5 minutes") \\
    .start()

# Batch-style (cheapest — run once, then stop):
df.writeStream \\
    .trigger(availableNow=True) \\
    .start()`,
    },
    'Streaming groupBy() without .withWatermark() — unbounded state': {
        detail: 'Streaming aggregations maintain state for every key seen. Without `.withWatermark()`, state grows indefinitely and will eventually exhaust executor memory.',
        fix: `df.withWatermark("event_time", "1 hour") \\
    .groupBy(
        F.window("event_time", "10 minutes"),
        "user_id"
    ).agg(F.count("*"))

# Rule of thumb: set watermark to 2–3× your p95 event latency`,
    },
    'DROP TABLE + CREATE TABLE — use CREATE OR REPLACE TABLE instead': {
        detail: '`DROP TABLE` + `CREATE TABLE` is non-atomic: concurrent readers see a missing table between the two statements, time-travel history is permanently deleted, and a failure between the two leaves no table at all.',
        fix: `# Single atomic operation — preserves readers and time travel:
spark.sql("""
    CREATE OR REPLACE TABLE my_table (
        id BIGINT, name STRING
    ) USING DELTA
""")`,
    },
    'Streaming query has no queryName — hard to identify in Spark UI': {
        detail: 'Without a `queryName`, streaming queries appear as random UUIDs in the Spark UI, structured streaming metrics, and logs. A descriptive name makes it easy to identify and alert on specific streams.',
        fix: `df.writeStream \\
    .option("queryName", "events_to_silver")  # descriptive name
    .trigger(processingTime="5 minutes") \\
    .start()`,
    },
    'OPTIMIZE after every MERGE — causes latency spikes per batch': {
        detail: 'Running `OPTIMIZE` after each MERGE triggers a full compaction pass on every micro-batch, adding significant latency. Enable Liquid Clustering so Delta compacts incrementally and automatically — no manual `OPTIMIZE` needed.',
        fix: `# Enable Liquid Clustering on the target table (one-time setup):
spark.sql("ALTER TABLE my_table CLUSTER BY (merge_key, event_date)")

# Remove per-batch OPTIMIZE from foreachBatch:
# spark.sql(f"OPTIMIZE {target_table}")  ← delete this line`,
    },
    'Inner join in streaming context may silently drop events': {
        detail: 'In a stream-static join, an inner join silently drops streaming events with no matching dimension record at processing time. Late-arriving dimension data can never recover those dropped events.',
        fix: `# Use left join to preserve all streaming events:
enriched = stream_df.join(dim_df, on="customer_id", how="left")

# Monitor null rates to detect unmatched events:
# enriched.filter(F.col("dim_col").isNull()).count()`,
    },

    // ── DLT rules ─────────────────────────────────────────────────────────────

    'DLT table uses PARTITION BY — use CLUSTER BY (Liquid Clustering) instead': {
        detail: '`PARTITION BY` creates fixed-layout partitions requiring manual `OPTIMIZE` runs and degrades performance with high cardinality. `CLUSTER BY` (Liquid Clustering) compacts data incrementally and automatically, replacing both `PARTITION BY` and `ZORDER BY`.',
        fix: `# Instead of:
@dlt.table(partition_cols=["event_date"])

# Use:
@dlt.table(cluster_by=["event_date", "event_type"])  # 1–4 keys

# In SQL:
-- CLUSTER BY (event_date, event_type)`,
    },
    'SELECT * in DLT pipeline — select only needed columns': {
        detail: '`SELECT *` reads all columns including ones downstream consumers do not use, increasing I/O and storage. Selecting specific columns also improves Liquid Clustering effectiveness.',
        fix: `-- Select specific columns:
SELECT event_id, user_id, event_time, event_type, payload
FROM LIVE.source_table`,
    },
    'read_files() without schemaHints — schema drift risk in production': {
        detail: '`read_files()` without `schemaHints` scans all files to infer the schema on startup (slow) and is vulnerable to schema drift — a new upstream field with an incompatible type breaks the pipeline silently.',
        fix: `SELECT * FROM read_files(
    "s3://bucket/events/",
    format => "json",
    schemaHints => "event_id BIGINT, user_id STRING, amount DECIMAL(18,2)"
)
-- New columns not in schemaHints are still inferred automatically`,
    },
    'APPLY AS DELETE WHEN after SEQUENCE BY — wrong clause order in AUTO CDC': {
        detail: 'In `APPLY CHANGES INTO`, `APPLY AS DELETE WHEN` must appear **before** `SEQUENCE BY`. Placing it after causes a syntax error or incorrect CDC behavior where deletes are not applied.',
        fix: `-- Correct clause order:
APPLY CHANGES INTO LIVE.target_table
FROM STREAM(LIVE.source_cdc)
KEYS (id)
APPLY AS DELETE WHEN operation = "DELETE"  -- ← before SEQUENCE BY
SEQUENCE BY updated_at
COLUMNS * EXCEPT (operation, updated_at)`,
    },
    'CLUSTER BY AUTO in production — consider explicit cluster keys': {
        detail: '`CLUSTER BY AUTO` is useful for prototyping, but explicit keys chosen to match your query filter patterns outperform `AUTO` for production tables (especially under 10 TB). `AUTO` adds overhead from analyzing query statistics to infer clustering columns.',
        fix: `-- Replace AUTO with explicit keys matching your most common filter columns:
CLUSTER BY (event_date, user_id)

-- Guidelines:
--   1–4 cluster keys (2 often outperform 4 for tables < 10 TB)
--   Prefer low-to-medium cardinality: date, region, event_type — not UUID`,
    },
    'Z-ORDER / ZORDER instead of Liquid Clustering': {
        detail: '`ZORDER BY` is a legacy optimization that rewrites the entire table or partition on each `OPTIMIZE` run. Liquid Clustering (`CLUSTER BY`) replaces it with incremental, automatic compaction — faster, cheaper, and no manual `OPTIMIZE` needed.',
        fix: `# Remove per-run OPTIMIZE + ZORDER:
# OPTIMIZE my_table ZORDER BY (event_date, user_id)  ← delete this

# Set Liquid Clustering once at table creation:
CREATE TABLE my_table (...) USING DELTA
CLUSTER BY (event_date, user_id)

# Or add to an existing table:
ALTER TABLE my_table CLUSTER BY (event_date, user_id)`,
    },
    'Dynamic allocation enabled on streaming cluster': {
        detail: 'Dynamic allocation scales executors up and down based on backlog, causing unpredictable latency spikes and executor churn on streaming workloads. When the cluster scales in during a quiet period it must ramp up again when load returns, adding restart latency to every batch.',
        fix: `# Remove dynamic allocation for streaming jobs:
# spark.conf.set("spark.dynamicAllocation.enabled", "true")  ← remove

# Use a fixed cluster sized to handle peak throughput.
# For cost efficiency with variable load, use availableNow=True:
df.writeStream.trigger(availableNow=True).start()`,
    },
    'Kafka auto-commit enabled': {
        detail: '`kafka.enable.auto.commit = true` lets Kafka manage offset commits independently of Spark\'s checkpoint. This causes **data loss** (offsets committed before processing completes) or **duplication** (offsets committed for records that were never processed). Spark manages Kafka offsets via checkpoints — always disable auto-commit.',
        fix: `stream = (spark.readStream
    .format("kafka")
    .option("kafka.enable.auto.commit", "false")  # Spark manages offsets
    .option("checkpointLocation", "/Volumes/catalog/schema/checkpoints/stream")
    .load())`,
    },
    'Streaming checkpoint stored on DBFS': {
        detail: 'DBFS is workspace-local and not designed for production checkpoint storage. Checkpoint corruption or loss causes the stream to restart from the beginning, risking data loss or unbounded reprocessing.',
        fix: `# Use Unity Catalog Volumes (recommended):
.option("checkpointLocation", "/Volumes/catalog/schema/checkpoints/my_stream")

# Or cloud-native paths:
.option("checkpointLocation", "s3://my-bucket/checkpoints/my_stream")
.option("checkpointLocation", "abfss://container@account.dfs.core.windows.net/checkpoints/stream")`,
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

                const info = ISSUE_INFO[diag.message]
                    ?? ISSUE_INFO_BY_PATTERN.find(p => p.pattern.test(diag.message))?.entry;
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

const NON_DF_NAMES = new Set(['F', 'functions', 'spark', 'sc', 'sqlContext', 'col', 'lit']);

/**
 * Hover provider that shows the output column schema when hovering over
 * a DataFrame .write or .writeStream call.
 */
export function createWriteSchemaHoverProvider(): vscode.HoverProvider {
    return {
        provideHover(
            document: vscode.TextDocument,
            position: vscode.Position,
        ): vscode.Hover | undefined {
            const lineText = document.lineAt(position).text;

            // Detect a .write or .writeStream call on this line
            const writeMatch = /\b([A-Za-z_]\w*)\.(writeStream|write)\b/.exec(lineText);
            if (!writeMatch) { return undefined; }

            const varName = writeMatch[1];
            const isStreaming = writeMatch[2] === 'writeStream';
            if (NON_DF_NAMES.has(varName)) { return undefined; }

            // Skip if followed by '(' — that would be file.write(data)
            const afterWrite = lineText.substring(writeMatch.index + writeMatch[0].length).trimStart();
            if (afterWrite.startsWith('(')) { return undefined; }

            const code = document.getText();
            const structSchemas = extractStructTypeSchemas(code);
            const ddlSchemas    = extractDdlSchemas(code);
            const history = buildDfSchemaMap(code, structSchemas, ddlSchemas);
            const schema  = schemaAtLine(history, varName, position.line);

            if (!schema || schema.length === 0) { return undefined; }

            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            md.supportThemeIcons = true;

            const writeLabel = isStreaming ? 'Streaming Write' : 'Write';
            md.appendMarkdown(`### $(database) ${writeLabel}: \`${varName}\`\n\n`);
            md.appendMarkdown(`**Output columns (${schema.length}):**\n\n`);
            md.appendMarkdown('| Column | Type |\n|--------|------|\n');
            for (const field of schema) {
                md.appendMarkdown(`| \`${field.name}\` | \`${field.type}\` |\n`);
            }

            return new vscode.Hover(md);
        },
    };
}
