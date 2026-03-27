package com.catalystops.documentation

import com.intellij.lang.documentation.AbstractDocumentationProvider
import com.intellij.psi.PsiElement

/**
 * Provides hover documentation for CatalystOps inspection rule IDs found in problem descriptions.
 *
 * IntelliJ surfaces static documentation from inspections via getStaticDescription() overrides
 * in each LocalInspectionTool. This provider supplements that by mapping rule IDs to rich
 * HTML documentation shown in Quick Documentation (F1) popups.
 */
class CatalystOpsDocumentationProvider : AbstractDocumentationProvider() {

    companion object {
        /** Map of rule ID prefix -> full HTML documentation block. */
        val RULE_DOCS: Map<String, String> = mapOf(

            // --- SparkAction ---
            "CODE_COLLECT_001" to """
                <html><body>
                <p><b>CODE_COLLECT_001</b> — <b>collect() Usage</b></p>
                <p>collect() pulls ALL rows from all executors to the single driver node. On datasets
                larger than driver memory this causes OutOfMemoryError and cluster instability.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
data = df.collect()
for row in data:
    process(row)

# Use df.foreach() to process on executors:
df.foreach(process)

# Or write to storage:
df.write.parquet("path/to/output")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_ITER_COLLECT_001" to """
                <html><body>
                <p><b>CODE_ITER_COLLECT_001</b> — <b>for-loop over collect()</b></p>
                <p>Iterating row-by-row over the result of collect() brings the entire dataset to the
                driver and then processes it sequentially — the worst of both worlds.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
for row in df.collect():
    process(row)

# Use df.foreach() to process in parallel on executors:
df.foreach(process)

# Or write results to storage:
df.write.parquet("output/")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_SHOW_001" to """
                <html><body>
                <p><b>CODE_SHOW_001</b> — <b>show() in production code</b></p>
                <p>show() triggers a full compute stage and prints to stdout. It is a development-time
                debugging tool and should not appear in production pipelines.</p>
                <h3>Quick fix</h3>
                <pre>
# Remove or replace with a write:
df.write.mode("overwrite").parquet("output/")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_COUNT_001" to """
                <html><body>
                <p><b>CODE_COUNT_001</b> — <b>count() in comparison</b></p>
                <p>df.count() &gt; 0 scans the entire dataset just to check existence. Use a cheaper
                existence check instead.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
if df.count() > 0:
    ...

# Use:
if not df.isEmpty():
    ...
# or:
if df.limit(1).count() > 0:
    ...
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_PANDAS_001" to """
                <html><body>
                <p><b>CODE_PANDAS_001</b> — <b>toPandas() / toLocalIterator()</b></p>
                <p>These methods bring all data to the driver. Only use them when the resulting dataset
                is known to be small (e.g., after aggregation).</p>
                <h3>Quick fix</h3>
                <pre>
# Before converting, ensure the data is small:
agg_df = df.groupBy("key").count()  # small result
pdf = agg_df.toPandas()
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkShuffle ---
            "CODE_SORT_001" to """
                <html><body>
                <p><b>CODE_SORT_001</b> — <b>Global sort / shuffle</b></p>
                <p>orderBy() / sort() at the global level triggers a full shuffle — every executor must
                exchange data with every other executor. This is O(N log N) network I/O.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of (global sort):
df.orderBy("col")

# Sort within each partition (no shuffle):
df.sortWithinPartitions("col")

# Or apply sorting only at the final write step
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_REPARTITION_WRITE_001" to """
                <html><body>
                <p><b>CODE_REPARTITION_WRITE_001</b> — <b>repartition() before write</b></p>
                <p>repartition() always causes a full shuffle regardless of whether you are increasing
                or decreasing partition count. When writing you usually want to reduce partitions, which
                coalesce() can do without a shuffle.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
df.repartition(10).write.parquet("output/")

# Use coalesce() when reducing partition count:
df.coalesce(10).write.parquet("output/")
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkUdf ---
            "CODE_UDF_001" to """
                <html><body>
                <p><b>CODE_UDF_001</b> — <b>udf() Usage</b></p>
                <p>Python UDFs require serialising each row between the JVM and Python, and disable
                Catalyst query optimisations entirely.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
from pyspark.sql.functions import udf
upper_udf = udf(lambda x: x.upper())
df.select(upper_udf("name"))

# Use built-in functions:
from pyspark.sql.functions import upper
df.select(upper("name"))
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_UDF_FILTER_001" to """
                <html><body>
                <p><b>CODE_UDF_FILTER_001</b> — <b>UDF inside filter()</b></p>
                <p>A UDF inside filter() prevents the Spark optimizer from pushing the predicate down
                to the data source. On Delta tables this disables partition pruning and file skipping,
                causing a full table scan.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
is_active = udf(lambda s: s == "active")
df.filter(is_active(col("status")))

# Use built-in comparison:
df.filter(col("status") == "active")
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkCaching ---
            "CODE_REPRO_001" to """
                <html><body>
                <p><b>CODE_REPRO_001</b> — <b>Repeated source scans</b></p>
                <p>The same DataFrame variable is read from source multiple times. Each use re-executes
                the full scan, potentially reading terabytes of data multiple times.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
df = spark.read.parquet("s3://bucket/data/")
r1 = df.filter(col("a") > 1)
r2 = df.groupBy("b").count()  # re-scans data

# Cache after first read:
df = spark.read.parquet("s3://bucket/data/").cache()
r1 = df.filter(col("a") > 1)
r2 = df.groupBy("b").count()  # reads from cache
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_REPEATED_ACTIONS_001" to """
                <html><body>
                <p><b>CODE_REPEATED_ACTIONS_001</b> — <b>Multiple actions without cache</b></p>
                <p>Each Spark action (count, show, collect, take, first) triggers a full re-computation
                of the entire DAG from source. Calling multiple actions on the same DataFrame re-runs
                all transformations each time.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
total = df.count()    # full scan
sample = df.show()    # another full scan

# Cache before the first action:
df = df.cache()
total = df.count()    # cached
sample = df.show()    # cached
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkSchema ---
            "CODE_SCHEMA_001" to """
                <html><body>
                <p><b>CODE_SCHEMA_001</b> — <b>inferSchema=True</b></p>
                <p>Schema inference requires reading the entire dataset (or a large sample) before
                returning the first row. On large files this doubles read time.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
df = spark.read.csv("data/", inferSchema=True)

# Provide an explicit schema:
from pyspark.sql.types import StructType, StructField, IntegerType, StringType
schema = StructType([
    StructField("id", IntegerType()),
    StructField("name", StringType()),
])
df = spark.read.schema(schema).csv("data/")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_SELECT_STAR_001" to """
                <html><body>
                <p><b>CODE_SELECT_STAR_001</b> — <b>select("*")</b></p>
                <p>Selecting all columns reads more data than necessary and prevents column pruning
                at the data source (e.g., Parquet column projection).</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
df.select("*")

# Select only needed columns:
df.select("id", "name", "value")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_READ_FILES_SCHEMA_001" to """
                <html><body>
                <p><b>CODE_READ_FILES_SCHEMA_001</b> — <b>read_files() without schemaHints</b></p>
                <p>Without schemaHints, read_files() infers the schema on every execution by sampling
                files. This is slow and can produce different schemas as new files arrive.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
df = read_files("s3://bucket/data/")

# Pin the schema with schemaHints:
df = read_files(
    "s3://bucket/data/",
    schemaHints="id INT, name STRING, value DOUBLE"
)
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkStreaming ---
            "CODE_STREAM_QUERY_NAME_001" to """
                <html><body>
                <p><b>CODE_STREAM_QUERY_NAME_001</b> — <b>Missing queryName()</b></p>
                <p>Without a query name, streaming queries get auto-generated IDs that change on restart,
                making observability and management difficult.</p>
                <h3>Quick fix</h3>
                <pre>
df.writeStream \
    .queryName("my_pipeline_query") \
    .format("delta") \
    .start()
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_STREAMING_WATERMARK_001" to """
                <html><body>
                <p><b>CODE_STREAMING_WATERMARK_001</b> — <b>groupBy() without withWatermark()</b></p>
                <p>Stateful operations like groupBy on a streaming DataFrame accumulate state for every
                key seen. Without a watermark, this state grows unboundedly and will eventually cause OOM.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
df.groupBy("user_id").count()

# Add watermark to bound state:
df.withWatermark("event_time", "10 minutes") \
  .groupBy("user_id").count()
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_STREAMING_INNER_JOIN_001" to """
                <html><body>
                <p><b>CODE_STREAMING_INNER_JOIN_001</b> — <b>Streaming inner join</b></p>
                <p>In streaming inner joins, events that arrive after the watermark threshold are
                silently dropped. This can cause data loss that is hard to detect.</p>
                <h3>Quick fix</h3>
                <pre>
# Use a left outer join with a watermark to handle late events:
df1.withWatermark("ts1", "10 minutes") \
   .join(df2.withWatermark("ts2", "10 minutes"), "key", "left_outer")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_DYNAMIC_ALLOC_001" to """
                <html><body>
                <p><b>CODE_DYNAMIC_ALLOC_001</b> — <b>Dynamic allocation on streaming cluster</b></p>
                <p>When dynamic allocation removes executors, in-progress streaming micro-batches lose
                their shuffle data and must retry. This causes instability and increased latency.</p>
                <h3>Quick fix</h3>
                <pre>
# Disable dynamic allocation for streaming jobs:
spark.conf.set("spark.dynamicAllocation.enabled", "false")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_AUTOLOADER_RATE_001" to """
                <html><body>
                <p><b>CODE_AUTOLOADER_RATE_001</b> — <b>Auto Loader without rate limit</b></p>
                <p>Without maxBytesPerTrigger, Auto Loader ingests all available files in the first
                trigger, which can overwhelm downstream systems and cause out-of-memory errors.</p>
                <h3>Quick fix</h3>
                <pre>
df = spark.readStream \
    .format("cloudFiles") \
    .option("cloudFiles.format", "json") \
    .option("maxBytesPerTrigger", "100m") \
    .load(path)
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_CHECKPOINT_DBFS_001" to """
                <html><body>
                <p><b>CODE_CHECKPOINT_DBFS_001</b> — <b>Checkpoint on DBFS</b></p>
                <p>DBFS is an abstraction layer over cloud storage but lacks the strong consistency
                guarantees needed for streaming checkpoints, making it unreliable for production.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
.option("checkpointLocation", "dbfs:/checkpoints/my_query")

# Use cloud storage directly:
.option("checkpointLocation", "s3://my-bucket/checkpoints/my_query")
# or Azure:
.option("checkpointLocation", "abfss://container@account.dfs.core.windows.net/checkpoints/")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_KAFKA_COMMIT_001" to """
                <html><body>
                <p><b>CODE_KAFKA_COMMIT_001</b> — <b>Kafka auto-commit enabled</b></p>
                <p>When auto-commit is enabled, Kafka commits offsets independently of Spark's
                processing. If a micro-batch fails, Spark retries but Kafka has already advanced the
                offset, causing data loss. If Spark commits first, offsets may be committed twice,
                causing duplication.</p>
                <h3>Quick fix</h3>
                <pre>
# Remove this option — Spark manages Kafka offsets automatically:
# .option("kafka.enable.auto.commit", "true")  # DELETE THIS

# Spark stores offsets in the checkpoint location:
.option("checkpointLocation", "s3://bucket/checkpoints/")
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkDelta ---
            "CODE_DELTA_MERGE_001" to """
                <html><body>
                <p><b>CODE_DELTA_MERGE_001</b> — <b>merge().execute() without match clauses</b></p>
                <p>Calling .execute() directly after .merge() without any whenMatched/whenNotMatched
                clauses has no effect and is likely a programming error.</p>
                <h3>Quick fix</h3>
                <pre>
delta_table.alias("target") \
    .merge(source.alias("source"), "target.id = source.id") \
    .whenMatchedUpdate(set={"value": "source.value"}) \
    .whenNotMatchedInsertAll() \
    .execute()
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_MERGE_DV_001" to """
                <html><body>
                <p><b>CODE_MERGE_DV_001</b> — <b>MERGE without Deletion Vectors</b></p>
                <p>Without Deletion Vectors, MERGE must rewrite entire Parquet files to mark deletions,
                which is slow on large tables. Deletion Vectors enable row-level delete markers.</p>
                <h3>Quick fix</h3>
                <pre>
spark.conf.set(
    "spark.databricks.delta.properties.defaults.enableDeletionVectors",
    "true"
)
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_OPTIMIZE_MERGE_001" to """
                <html><body>
                <p><b>CODE_OPTIMIZE_MERGE_001</b> — <b>OPTIMIZE after every MERGE</b></p>
                <p>OPTIMIZE rewrites all small files in a Delta table into larger, sorted files.
                Running it after every MERGE causes significant write amplification and latency spikes.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of (inside a loop):
for batch in batches:
    delta_table.merge(...).execute()
    spark.sql("OPTIMIZE my_table")  # runs N times!

# Run OPTIMIZE separately on a schedule:
for batch in batches:
    delta_table.merge(...).execute()
# After all merges:
spark.sql("OPTIMIZE my_table ZORDER BY (key_col)")
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_FLOAT_FINANCIAL_001" to """
                <html><body>
                <p><b>CODE_FLOAT_FINANCIAL_001</b> — <b>FLOAT/DOUBLE for financial values</b></p>
                <p>IEEE 754 floating-point types (FLOAT, DOUBLE) cannot represent many decimal fractions
                exactly. Financial calculations accumulate rounding errors that can cause regulatory and
                audit failures.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
StructField("price", FloatType())
StructField("amount", DoubleType())

# Use DecimalType with explicit precision and scale:
StructField("price", DecimalType(18, 4))
StructField("amount", DecimalType(18, 4))
                </pre>
                </body></html>
            """.trimIndent(),

            "CODE_DLT_CDC_ORDER_001" to """
                <html><body>
                <p><b>CODE_DLT_CDC_ORDER_001</b> — <b>APPLY CHANGES CDC clause order</b></p>
                <p>In DLT CDC pipelines, APPLY AS TRUNCATE WHEN must appear before APPLY AS DELETE WHEN.
                Having DELETE before TRUNCATE produces incorrect results.</p>
                <h3>Quick fix</h3>
                <pre>
APPLY CHANGES INTO target
FROM source
KEYS (id)
APPLY AS DELETE WHEN operation = "DELETE"
APPLY AS TRUNCATE WHEN operation = "TRUNCATE"
SEQUENCE BY sequence_num
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkConfig ---
            "CODE_AQE_001" to """
                <html><body>
                <p><b>CODE_AQE_001</b> — <b>AQE explicitly disabled</b></p>
                <p>Adaptive Query Execution dynamically re-optimises query plans at runtime: it
                auto-tunes shuffle partition count, handles data skew, and converts sort-merge joins to
                broadcast joins when possible.</p>
                <h3>Quick fix</h3>
                <pre>
# Remove the line disabling AQE, or explicitly enable it:
spark.conf.set("spark.sql.adaptive.enabled", "true")
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkJoin ---
            "CODE_CROSSJOIN_001" to """
                <html><body>
                <p><b>CODE_CROSSJOIN_001</b> — <b>crossJoin() Cartesian product</b></p>
                <p>A cross join between two DataFrames of size N and M produces N×M rows. This is
                almost always unintentional and can produce billions of rows.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
df1.crossJoin(df2)

# Use an explicit join key:
df1.join(df2, df1.id == df2.id, "inner")
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkLoop ---
            "CODE_WITHCOL_LOOP_001" to """
                <html><body>
                <p><b>CODE_WITHCOL_LOOP_001</b> — <b>withColumn() inside a loop</b></p>
                <p>Each withColumn() call adds a new node to the logical query plan. In a loop with N
                iterations you get a plan of depth N, causing exponential planning time and often
                StackOverflowError.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
for col_name in columns:
    df = df.withColumn(col_name, transform(col(col_name)))

# Build all expressions first, then select once:
from pyspark.sql.functions import col
exprs = [transform(col(c)).alias(c) for c in columns]
df = df.select("*", *exprs)
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkWindow ---
            "CODE_WINDOW_001" to """
                <html><body>
                <p><b>CODE_WINDOW_001</b> — <b>Window.orderBy() without partitionBy()</b></p>
                <p>A window without partitionBy() treats the entire dataset as a single partition.
                All data is shuffled to one executor, causing OOM on large datasets.</p>
                <h3>Quick fix</h3>
                <pre>
# Instead of:
window = Window.orderBy("timestamp")

# Partition by a meaningful key:
window = Window.partitionBy("user_id").orderBy("timestamp")
                </pre>
                </body></html>
            """.trimIndent(),

            // --- SparkSecurity ---
            "CODE_SQL_INJECT_001" to """
                <html><body>
                <p><b>CODE_SQL_INJECT_001</b> — <b>SQL injection via f-string</b></p>
                <p>If user-controlled values are interpolated into SQL via f-strings, an attacker can
                inject arbitrary SQL statements.</p>
                <h3>Quick fix</h3>
                <pre>
# Dangerous:
spark.sql(f"SELECT * FROM users WHERE id = {user_input}")

# Safe — use the DataFrame API:
df.filter(col("id") == user_input)

# Or sanitise/parameterise if SQL is required:
# Validate user_input is an integer before interpolating
                </pre>
                </body></html>
            """.trimIndent(),
        )
    }

    /**
     * generateDoc is called when the user triggers Quick Documentation (F1) on a PSI element.
     * We check whether the element's text contains a known rule ID and return the corresponding doc.
     */
    override fun generateDoc(element: PsiElement, originalElement: PsiElement?): String? {
        val text = element.text ?: return null
        for ((ruleId, doc) in RULE_DOCS) {
            if (text.contains(ruleId)) return doc
        }
        return null
    }
}
