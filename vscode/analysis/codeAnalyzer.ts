/**
 * Local code analyzer - Port of python/spark_optimizer/analyzers/code_analyzer.py
 * Detects 23 PySpark anti-patterns via regex without needing a cluster connection.
 */

import { CodeIssue, Severity, IssueCategory, Fix } from '../models/types';
import { validateSchema } from './schemaValidator';

interface CodePattern {
    id: string;
    name: string;
    pattern: RegExp;
    severity: Severity;
    category: IssueCategory;
    description: string;
    fix: Fix;
}

const antiPatterns: CodePattern[] = [
    {
        id: 'CODE_UDF_001',
        name: 'UDF Usage Detected',
        pattern: /(?:@udf|udf\s*\(|\.udf\.|F\.udf)/gi,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'User Defined Functions (UDFs) prevent Spark from optimizing the query plan and cause serialization overhead',
        fix: {
            description: 'Replace UDFs with built-in Spark SQL functions when possible',
            code: `# Instead of:
my_udf = udf(lambda x: x * 2)
df.withColumn("doubled", my_udf(col("value")))

# Use built-in functions:
df.withColumn("doubled", col("value") * 2)`,
        },
    },
    {
        id: 'CODE_COLLECT_001',
        name: 'collect() Usage',
        pattern: /\.collect\s*\(\s*\)/g,
        severity: Severity.CRITICAL,
        category: IssueCategory.CODE,
        description: 'collect() brings all data to the driver, which can cause OOM errors on large datasets',
        fix: {
            description: 'Use take(), limit(), or write to storage instead of collect()',
            code: `# Instead of:
data = df.collect()

# Use:
sample = df.take(1000)  # Get limited rows
# or
df.write.parquet("path")  # Write to storage`,
        },
    },
    {
        id: 'CODE_PANDAS_001',
        name: 'toPandas() Usage',
        pattern: /\.toPandas\s*\(\s*\)/g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'toPandas() brings all data to the driver and converts to Pandas, which can cause OOM errors',
        fix: {
            description: 'Filter or aggregate data before calling toPandas(), or use Spark operations',
            code: `# Instead of:
pandas_df = df.toPandas()

# Use:
pandas_df = df.limit(10000).toPandas()  # Limit first
# or use Spark for processing`,
        },
    },
    {
        id: 'CODE_SCHEMA_001',
        name: 'Schema Inference',
        pattern: /\.option\s*\(\s*["']inferSchema["']\s*,\s*["']true["']\s*\)/gi,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'Schema inference requires an extra pass over the data. Providing an explicit schema is faster',
        fix: {
            description: 'Provide an explicit schema instead of inferring',
            code: `# Instead of:
spark.read.option("inferSchema", "true").csv("path")

# Use:
from pyspark.sql.types import StructType, StructField, StringType, IntegerType
schema = StructType([
    StructField("col1", StringType()),
    StructField("col2", IntegerType())
])
spark.read.schema(schema).csv("path")`,
        },
    },
    {
        id: 'CODE_FILTER_001',
        name: 'Multiple Filter Operations',
        pattern: /\.filter\s*\([^)]+\)\s*\.filter\s*\(/g,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'Multiple filter operations can be combined into a single filter for clarity',
        fix: {
            description: 'Combine multiple filters using AND conditions',
            code: `# Instead of:
df.filter(col("a") > 1).filter(col("b") < 10)

# Use:
df.filter((col("a") > 1) & (col("b") < 10))`,
        },
    },
    {
        id: 'CODE_COUNT_001',
        name: 'Unnecessary count()',
        pattern: /\.count\s*\(\s*\)\s*[><=!]/g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'Using count() > 0 to check for non-empty DataFrame triggers full computation',
        fix: {
            description: 'Use .isEmpty() or take(1) instead of count() > 0',
            code: `# Instead of:
if df.count() > 0:
    ...

# Use:
if not df.isEmpty():
    ...
# or
if len(df.take(1)) > 0:
    ...`,
        },
    },
    {
        id: 'CODE_RDD_001',
        name: 'RDD Conversion',
        pattern: /\.rdd\./g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'Converting DataFrame to RDD loses Catalyst optimizations',
        fix: {
            description: 'Use DataFrame/Dataset APIs instead of RDD operations when possible',
            code: `# Instead of:
df.rdd.map(lambda row: ...)

# Use:
df.select(...).withColumn(...)
# or DataFrame transformations`,
        },
    },
    {
        id: 'CODE_COALESCE_001',
        name: 'coalesce(1) Detected',
        pattern: /\.coalesce\s*\(\s*1\s*\)/g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'coalesce(1) forces all data through a single partition, losing parallelism',
        fix: {
            description: 'Only use coalesce(1) for small datasets. For large datasets, keep multiple partitions',
            code: `# coalesce(1) is OK for small outputs:
small_df.coalesce(1).write.csv("path")

# For large datasets, keep parallelism:
large_df.write.parquet("path")  # Multiple files is OK`,
        },
    },
    {
        id: 'CODE_SHOW_001',
        name: 'show() in Production',
        pattern: /\.show\s*\(\s*\)/g,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'show() triggers computation and should be removed in production code',
        fix: {
            description: 'Remove show() calls in production code, use logging or monitoring instead',
        },
    },
    {
        id: 'CODE_PERSIST_001',
        name: 'Unpersisted DataFrame',
        pattern: /\.cache\s*\(\s*\)|\.persist\s*\(/g,
        severity: Severity.INFO,
        category: IssueCategory.CACHING,
        description: 'DataFrame is cached - ensure it\'s unpersisted when no longer needed',
        fix: {
            description: 'Call unpersist() when cached DataFrame is no longer needed',
            code: `# Always unpersist when done:
df_cached = df.cache()
# ... use df_cached ...
df_cached.unpersist()`,
        },
    },
    {
        id: 'CODE_CROSSJOIN_001',
        name: 'Cross Join Detected',
        pattern: /\.crossJoin\s*\(/g,
        severity: Severity.CRITICAL,
        category: IssueCategory.JOIN,
        description: 'Cross join creates cartesian product which can explode data size',
        fix: {
            description: 'Add join conditions or filter to reduce result size',
            code: `# Instead of:
df1.crossJoin(df2)

# Use explicit join with condition:
df1.join(df2, df1["key"] == df2["key"])`,
        },
    },
    {
        id: 'CODE_ORDERBY_001',
        name: 'Global orderBy Detected',
        pattern: /\.orderBy\s*\(|\.sort\s*\(/g,
        severity: Severity.INFO,
        category: IssueCategory.SHUFFLE,
        description: 'Global orderBy requires shuffling all data to a single partition',
        fix: {
            description: 'Consider if global ordering is necessary, or use sortWithinPartitions for local sorting',
            code: `# For local sorting (no shuffle):
df.sortWithinPartitions("column")

# Or limit before sorting:
df.limit(1000).orderBy("column")`,
        },
    },
    {
        id: 'CODE_REPARTITION_001',
        name: 'repartition(1) Detected',
        pattern: /\.repartition\s*\(\s*1\s*\)/g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'repartition(1) forces a full shuffle to produce a single partition, losing all parallelism. This is worse than coalesce(1) as it triggers an unnecessary shuffle',
        fix: {
            description: 'Use coalesce(1) if you truly need a single partition (avoids full shuffle), or keep multiple partitions for large datasets',
            code: `# Instead of:
df.repartition(1).write.parquet("path")

# Use coalesce (no shuffle):
df.coalesce(1).write.parquet("path")

# Or better, keep parallelism:
df.write.parquet("path")  # Multiple files is OK`,
        },
    },
    {
        id: 'CODE_PANDAS_UDF_001',
        name: 'pandas_udf Usage Detected',
        pattern: /@pandas_udf|pandas_udf\s*\(/g,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'pandas_udf (vectorized UDF) is better than regular UDF but still prevents some Catalyst optimizations. Ensure built-in functions cannot achieve the same result',
        fix: {
            description: 'Prefer built-in Spark SQL functions over pandas_udf when possible. pandas_udf is acceptable when built-in functions are insufficient',
            code: `# pandas_udf is OK for complex operations:
@pandas_udf(returnType=DoubleType())
def complex_calc(s: pd.Series) -> pd.Series:
    return s.apply(some_complex_logic)

# But prefer built-in when possible:
df.withColumn("result", F.sqrt(F.col("value")))`,
        },
    },
    {
        id: 'CODE_TOPANDAS_SPARK_001',
        name: 'to_pandas_on_spark() Conversion',
        pattern: /\.to_pandas_on_spark\s*\(\s*\)|\.pandas_api\s*\(\s*\)/g,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'Converting Spark DataFrame to pandas-on-Spark API can introduce subtle performance issues and API inconsistencies',
        fix: {
            description: 'Use native Spark DataFrame operations for better performance and optimization',
            code: `# Instead of:
psdf = df.to_pandas_on_spark()
psdf.groupby("col").mean()

# Use native Spark:
df.groupBy("col").agg(F.mean("value"))`,
        },
    },
    {
        id: 'CODE_DROP_DUP_001',
        name: 'dropDuplicates() Without Subset',
        pattern: /\.dropDuplicates\s*\(\s*\)|\.drop_duplicates\s*\(\s*\)/g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'dropDuplicates() without specifying a subset of columns compares ALL columns, which is expensive and may not be the intended behavior',
        fix: {
            description: 'Specify the subset of columns to check for duplicates',
            code: `# Instead of:
df.dropDuplicates()

# Specify key columns:
df.dropDuplicates(["id", "timestamp"])`,
        },
    },
    {
        id: 'CODE_DISPLAY_001',
        name: 'display() in Production Code',
        pattern: /(?<!\w)display\s*\(\s*\w/g,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'display() triggers computation and is meant for interactive notebooks. It should be removed or guarded in production pipelines',
        fix: {
            description: 'Remove display() calls in production code, use logging or write to storage for monitoring',
            code: `# Instead of:
display(df)

# Write to storage or log:
df.write.parquet("output_path")
logger.info(f"Row count: {df.count()}")`,
        },
    },
    {
        id: 'CODE_SQL_INJECT_001',
        name: 'SQL Injection Risk in spark.sql()',
        pattern: /spark\.sql\s*\(\s*f['"]|spark\.sql\s*\(\s*['"].*\.format\s*\(|spark\.sql\s*\(\s*['"].*%\s/g,
        severity: Severity.CRITICAL,
        category: IssueCategory.SECURITY,
        description: 'Using f-strings, .format(), or % formatting in spark.sql() can lead to SQL injection vulnerabilities if any variables come from user input',
        fix: {
            description: 'Use parameterized queries or DataFrame API instead of string interpolation in SQL',
            code: `# Instead of:
spark.sql(f"SELECT * FROM table WHERE id = '{user_id}'")
spark.sql("SELECT * FROM table WHERE id = '{}'".format(user_id))

# Use DataFrame API:
df.filter(F.col("id") == user_id)

# Or parameterized SQL (Spark 3.4+):
spark.sql("SELECT * FROM table WHERE id = :id", args={"id": user_id})`,
        },
    },
    {
        id: 'CODE_WRITE_MODE_001',
        name: 'Write Without Mode Specified',
        pattern: /\.write\.(?!mode|format|option|save|partitionBy|bucketBy|sortBy|insertInto|jdbc|json|csv|parquet|orc|text|trigger|outputMode)/g,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'Writing without specifying a mode defaults to \'errorIfExists\', which will fail if the target already exists. This is often unintentional',
        fix: {
            description: 'Explicitly specify the write mode (overwrite, append, ignore, errorIfExists)',
            code: `# Specify write mode explicitly:
df.write.mode("overwrite").parquet("path")
df.write.mode("append").parquet("path")`,
        },
    },
    {
        id: 'CODE_NONDETERMINISTIC_UDF_001',
        name: 'Non-deterministic Operation in UDF',
        pattern: /(?:udf|pandas_udf)\s*\((?:[^)]*\n)*?[^)]*(?:random\.|rand\(|uuid|datetime\.now|time\.time)\s*/gm,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'Non-deterministic operations (random, uuid, datetime.now) inside UDFs can produce inconsistent results when tasks are retried',
        fix: {
            description: 'Use Spark\'s built-in non-deterministic functions (F.rand(), F.monotonically_increasing_id()) or mark UDFs as non-deterministic',
            code: `# Instead of random in UDF:
@udf(returnType=DoubleType())
def add_noise(x):
    return x + random.random()

# Use Spark's built-in:
df.withColumn("noisy", F.col("value") + F.rand())

# Or mark UDF as non-deterministic:
my_udf = udf(func, DoubleType()).asNondeterministic()`,
        },
    },
    {
        id: 'CODE_DEPRECATED_APPEND_001',
        name: 'Deprecated DataFrame.append() Usage',
        pattern: /\.append\s*\(\s*(?:pd\.|pandas\.)/g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'pandas DataFrame.append() is deprecated since pandas 1.4.0 and removed in 2.0. Use pd.concat() instead',
        fix: {
            description: 'Replace .append() with pd.concat()',
            code: `# Instead of:
df = df.append(new_row)
df = df.append(other_df)

# Use pd.concat():
df = pd.concat([df, pd.DataFrame([new_row])])
df = pd.concat([df, other_df], ignore_index=True)`,
        },
    },
    {
        id: 'CODE_SELECT_STAR_001',
        name: "select('*') Usage",
        pattern: /\.select\s*\(\s*['"]?\*['"]?\s*\)/g,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: "select('*') reads all columns which may be unnecessary. Selecting only needed columns reduces I/O and memory usage, especially with columnar formats like Parquet",
        fix: {
            description: 'Select only the columns you need',
            code: `# Instead of:
df.select("*")

# Select specific columns:
df.select("id", "name", "value")`,
        },
    },
    {
        id: 'CODE_CHECKPOINT_001',
        name: 'checkpoint() Usage',
        pattern: /\.checkpoint\s*\(\s*\)/g,
        severity: Severity.WARNING,
        category: IssueCategory.CACHING,
        description: 'checkpoint() writes the full DataFrame to distributed storage and truncates the lineage graph, incurring I/O cost every time. Use .cache() for in-memory persistence, or .localCheckpoint() for faster checkpointing without HDFS writes',
        fix: {
            description: 'Prefer cache() for in-memory or localCheckpoint() for faster checkpointing',
            code: `# In-memory (fastest reads, requires executor memory):
df.cache()

# Local checkpoint (no HDFS write, faster than checkpoint()):
df.localCheckpoint()`,
        },
    },
    {
        id: 'CODE_AQE_001',
        name: 'Adaptive Query Execution Disabled',
        pattern: /spark\.conf\.set\s*\(\s*["']spark\.sql\.adaptive\.enabled["']\s*,\s*(?:["']false["']|False)\s*\)/gi,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'Adaptive Query Execution (AQE) is disabled. AQE dynamically re-optimises query plans at runtime — coalescing small shuffle partitions, handling join skew, and switching join strategies — and should remain enabled in production.',
        fix: {
            description: 'Remove the override to keep AQE enabled (it is on by default in Spark 3.x)',
            code: `# Remove or flip the override:
# spark.conf.set("spark.sql.adaptive.enabled", "false")  # ← remove this line

# AQE is enabled by default in Spark 3.x.
# Only disable it temporarily for debugging plan regressions.`,
        },
    },
    {
        id: 'CODE_UNION_001',
        name: 'union() Matches by Column Position, Not Name',
        // Match .union( but NOT .unionByName(
        pattern: /\.union(?!ByName)\s*\(/g,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'union() combines DataFrames by column position. If the two schemas have a different column order, values will be silently placed in the wrong columns. Use unionByName() to match columns by name instead.',
        fix: {
            description: 'Replace .union() with .unionByName() for schema-safe merging',
            code: `# Instead of:
result = df1.union(df2)          # position-based — silent data corruption if order differs

# Use:
result = df1.unionByName(df2)    # name-based — safe regardless of column order

# If DataFrames have different column sets, add allowMissingColumns:
result = df1.unionByName(df2, allowMissingColumns=True)`,
        },
    },
    {
        id: 'CODE_ZORDER_001',
        name: 'Z-ORDER / ZORDER instead of Liquid Clustering',
        pattern: /\bZORDER\s+BY\b|\bZ-ORDER\s+BY\b/gi,
        severity: Severity.INFO,
        category: IssueCategory.CODE,
        description: 'ZORDER BY is a legacy optimization that rewrites the entire table or partition on each OPTIMIZE run. Liquid Clustering (CLUSTER BY) replaces it with incremental, automatic compaction that is faster, cheaper, and requires no manual OPTIMIZE runs.',
        fix: {
            description: 'Replace ZORDER BY with CLUSTER BY (Liquid Clustering) when creating or altering the table',
            code: `# Instead of (legacy):
OPTIMIZE my_table ZORDER BY (event_date, user_id)

# Use Liquid Clustering (set once at table creation or via ALTER TABLE):
CREATE TABLE my_table (...)
USING DELTA
CLUSTER BY (event_date, user_id)

# Or add to an existing table:
ALTER TABLE my_table CLUSTER BY (event_date, user_id)

# Limit to 1–4 cluster keys; 2 keys often outperform 4 for tables under 10 TB.`,
        },
    },
    {
        id: 'CODE_DYN_ALLOC_STREAM_001',
        name: 'Dynamic allocation enabled on streaming cluster',
        pattern: /spark\.conf\.set\s*\(\s*["']spark\.dynamicAllocation\.enabled["']\s*,\s*(?:["']true["']|True\b)/gi,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'Dynamic allocation scales executors up and down based on backlog. On streaming workloads this causes unpredictable latency spikes and executor churn as the cluster scales in during quiet periods and must ramp up again when load returns. Use a fixed-size cluster for all streaming pipelines.',
        fix: {
            description: 'Disable dynamic allocation for streaming and use a fixed-size cluster',
            code: `# Remove or disable dynamic allocation for streaming jobs:
# spark.conf.set("spark.dynamicAllocation.enabled", "true")  ← remove

# Use a fixed cluster size sized to handle peak throughput.
# For cost efficiency with variable load, use .trigger(availableNow=True)
# on a scheduled job instead of a long-running streaming cluster.`,
        },
    },
    {
        id: 'CODE_KAFKA_001',
        name: 'Kafka auto-commit enabled',
        pattern: /["']kafka\.enable\.auto\.commit["']\s*,\s*(?:["']true["']|True\b)/g,
        severity: Severity.CRITICAL,
        category: IssueCategory.CODE,
        description: 'kafka.enable.auto.commit = true lets Kafka manage offset commits independently of Spark\'s checkpoint. This causes data loss (offsets committed before processing completes) or duplication (offsets committed for records never processed). Spark manages Kafka offsets via checkpoints — always disable auto-commit.',
        fix: {
            description: 'Set kafka.enable.auto.commit to false and let Spark manage offsets via checkpoints',
            code: `# Instead of:
stream = (spark.readStream
    .format("kafka")
    .option("kafka.enable.auto.commit", "true")  # ← dangerous
    .load())

# Use:
stream = (spark.readStream
    .format("kafka")
    .option("kafka.enable.auto.commit", "false")  # Spark manages offsets via checkpoint
    .load())`,
        },
    },
    {
        id: 'CODE_DBFS_CHECKPOINT_001',
        name: 'Streaming checkpoint stored on DBFS',
        pattern: /\.option\s*\(\s*["']checkpointLocation["']\s*,\s*["'](?:\/dbfs\/|dbfs:\/)/gi,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        description: 'Streaming checkpoints stored on DBFS are unreliable — DBFS is workspace-local and not designed for production checkpoint storage. Checkpoint corruption or loss causes the stream to restart from the beginning, risking data loss or reprocessing.',
        fix: {
            description: 'Store checkpoints on Unity Catalog Volumes or cloud-native storage (S3/ADLS)',
            code: `# Instead of:
.option("checkpointLocation", "/dbfs/checkpoints/my_stream")   # unreliable

# Use Unity Catalog Volumes (recommended):
.option("checkpointLocation", "/Volumes/catalog/schema/checkpoints/my_stream")

# Or cloud-native paths:
.option("checkpointLocation", "s3://my-bucket/checkpoints/my_stream")
.option("checkpointLocation", "abfss://container@account.dfs.core.windows.net/checkpoints/stream")`,
        },
    },
];

/**
 * Check if a column offset falls inside a Python comment on the given line.
 * Handles both full-line comments and inline comments, while ignoring
 * '#' characters inside string literals.
 */
function isInsideComment(line: string, column: number): boolean {
    let inString: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inString) {
            if (ch === '\\') { i++; continue; } // skip escaped char
            if (ch === inString) { inString = null; }
        } else {
            if (ch === '"' || ch === "'") { inString = ch; }
            else if (ch === '#') {
                // Everything from here to end-of-line is a comment
                return column >= i;
            }
        }
    }
    return false;
}

/**
 * Analyze code for PySpark anti-patterns.
 * Returns issues with exact line/column positions for VS Code diagnostics.
 */
export interface AnalyzeOptions {
    enableRepeatedScanDetection?: boolean;
}

export function analyzeCode(code: string, options: AnalyzeOptions = {}): CodeIssue[] {
    const issues: CodeIssue[] = [];
    const lines = code.split('\n');

    for (const pattern of antiPatterns) {
        // Reset lastIndex for global regexes
        pattern.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.pattern.exec(code)) !== null) {
            const offset = match.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;

            // Skip matches inside comments or suppressed with # noqa: catalystops
            const lineText = lines[lineNum];
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            issues.push({
                id: pattern.id,
                severity: pattern.severity,
                category: pattern.category,
                title: pattern.name,
                description: pattern.description,
                fix: pattern.fix,
                line: lineNum,
                column: column,
                endLine: lineNum,
                endColumn: column + match[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // Extra pass: flag dropDuplicates on streaming DataFrames (cross-batch stateful dedup).
    // Only triggered when the file contains readStream, since static analysis cannot
    // track variable types. Flags all dropDuplicates calls (with or without a subset)
    // because both create a StreamingDeduplicate node that silently drops updates.
    if (/\breadStream\b/.test(code)) {
        const streamDedupRe = /\.dropDuplicates\s*\(/g;
        streamDedupRe.lastIndex = 0;
        let sdm: RegExpExecArray | null;
        while ((sdm = streamDedupRe.exec(code)) !== null) {
            const offset = sdm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            if (isInsideComment(lines[lineNum], column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lines[lineNum])) { continue; }
            issues.push({
                id: 'CODE_STREAM_DEDUP_001',
                severity: Severity.INFO,
                category: IssueCategory.CODE,
                title: 'dropDuplicates on Streaming DataFrame (Cross-Batch Stateful Dedup)',
                description: 'dropDuplicates on a streaming DataFrame creates a StreamingDeduplicate node that maintains state across ALL micro-batches. Each key is emitted only the first time it is seen — subsequent updates for the same key are silently dropped forever. This is rarely the intended behavior for update or change-data streams.',
                fix: {
                    description: 'Move deduplication inside foreachBatch for per-batch dedup, or use a watermark for time-bounded dedup',
                    code: `# Per-batch dedup inside foreachBatch:
def process_batch(batch_df, batch_id):
    batch_df.dropDuplicates(["id"]).write.mode("append").saveAsTable("t")

streaming_df.writeStream.foreachBatch(process_batch).start()

# Time-bounded dedup with watermark (state expires):
streaming_df \\
    .withWatermark("event_time", "1 hour") \\
    .dropDuplicates(["id", "event_time"])`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + sdm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // Window without partitionBy: Window.orderBy(...) with no partitionBy creates a
    // global window — all rows are sorted into a single partition, causing OOM and
    // extreme slowness on large DataFrames.
    {
        const winRe = /\bWindow\.orderBy\s*\(/g;
        let wm: RegExpExecArray | null;
        while ((wm = winRe.exec(code)) !== null) {
            const offset = wm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Look back up to 5 lines to collect the full logical statement
            // (handles multi-line window specs with backslash / paren continuation).
            const ctxStart = Math.max(0, lineNum - 5);
            const ctxText = lines.slice(ctxStart, lineNum + 1).join('\n');
            if (/\.partitionBy\s*\(/.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_WINDOW_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: 'Window.orderBy() without partitionBy — global window',
                description: 'Window.orderBy() without partitionBy() creates a global window that moves ALL rows to a single partition for sorting. This causes executor OOM and loses all parallelism on large DataFrames.',
                fix: {
                    description: 'Add partitionBy() to limit each window to a relevant subset of rows',
                    code: `# Instead of:
w = Window.orderBy("timestamp")           # global — all data in one partition

# Use partitionBy to scope the window:
w = Window.partitionBy("user_id").orderBy("timestamp")

# If you genuinely need a global rank, repartition first to avoid silent skew:
df = df.repartition(1)
w = Window.orderBy("value")`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + wm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // Dynamic partition overwrite: writing with mode("overwrite") + partitionBy()
    // without spark.sql.sources.partitionOverwriteMode = dynamic replaces the entire
    // table on every run instead of only the affected partitions.
    if (!/partitionOverwriteMode["']\s*,\s*["']dynamic/i.test(code)) {
        // Match .write.mode("overwrite") ... .partitionBy( on the same logical statement
        // (check within an 8-line window to handle chained multi-line writes).
        const modeRe = /\.mode\s*\(\s*["']overwrite["']\s*\)/g;
        let mm: RegExpExecArray | null;
        while ((mm = modeRe.exec(code)) !== null) {
            const offset = mm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Collect the logical write chain (up to 8 lines around the match)
            const ctxStart = Math.max(0, lineNum - 4);
            const ctxEnd = Math.min(lines.length - 1, lineNum + 4);
            const ctxText = lines.slice(ctxStart, ctxEnd + 1).join('\n');
            if (!/\.write\b/.test(ctxText)) { continue; }
            if (!/\.partitionBy\s*\(/.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_DYN_PART_001',
                severity: Severity.INFO,
                category: IssueCategory.CODE,
                title: 'Static partition overwrite — consider dynamic partition overwrite',
                description: 'write.mode("overwrite").partitionBy(...) replaces the entire table by default. With static overwrite, even unrelated partitions are deleted. Enable dynamic partition overwrite to rewrite only the partitions present in the DataFrame.',
                fix: {
                    description: 'Enable dynamic partition overwrite so only affected partitions are replaced',
                    code: `# Enable dynamic partition overwrite (once, at session start):
spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")

# Then your write stays the same:
df.write.mode("overwrite").partitionBy("date").parquet("path")
# Only partitions whose "date" values appear in df are overwritten.`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + mm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // withColumn-in-loop check: scan line by line to confirm .withColumn() is
    // actually inside the for-loop body (indented deeper than the `for` line).
    // The previous regex approach incorrectly fired on any for-loop when .withColumn
    // appeared anywhere later in the file.
    {
        const forRe = /^([ \t]*)for\s+\w+\s+in\s+[^:\n]+:/;
        for (let i = 0; i < lines.length; i++) {
            const forMatch = forRe.exec(lines[i]);
            if (!forMatch) { continue; }
            if (isInsideComment(lines[i], lines[i].indexOf('for'))) { continue; }
            if (/# noqa: catalystops\b/i.test(lines[i])) { continue; }

            const forIndent = forMatch[1].length;
            // Scan the body: lines that are indented more than the `for` line
            for (let j = i + 1; j < lines.length; j++) {
                const bodyLine = lines[j];
                // Blank lines are allowed inside loop bodies
                if (bodyLine.trim() === '') { continue; }
                // Count leading whitespace of this line
                const bodyIndent = (bodyLine.match(/^([ \t]*)/) ?? ['', ''])[1].length;
                // Dedented back to `for` level or beyond — we've left the loop body
                if (bodyIndent <= forIndent) { break; }
                // Check for .withColumn( on this body line (not in a comment)
                const wcIdx = bodyLine.indexOf('.withColumn(');
                if (wcIdx === -1) { continue; }
                if (isInsideComment(bodyLine, wcIdx)) { continue; }

                issues.push({
                    id: 'CODE_WITHCOL_LOOP_001',
                    severity: Severity.WARNING,
                    category: IssueCategory.CODE,
                    title: 'withColumn in Loop',
                    description: 'Calling withColumn() inside a loop creates a new DataFrame per iteration, leading to deeply nested query plans that cause StackOverflow errors and poor performance',
                    fix: {
                        description: 'Use select() with a list of column expressions, or functools.reduce to batch column operations',
                        code: `# Instead of:
for col_name in columns:
    df = df.withColumn(col_name, F.upper(F.col(col_name)))

# Use select with list comprehension:
df = df.select([
    F.upper(F.col(c)).alias(c) if c in columns else F.col(c)
    for c in df.columns
])

# Or use functools.reduce:
from functools import reduce
df = reduce(
    lambda d, c: d.withColumn(c, F.upper(F.col(c))),
    columns, df
)`,
                    },
                    line: i,
                    column: lines[i].indexOf('for'),
                    endLine: i,
                    endColumn: lines[i].length,
                    location: `Line ${i + 1}`,
                });
                break; // one issue per loop, first withColumn found
            }
        }
    }

    // Repeated source scan detection with alias and derived-lineage tracking.
    // Opt-in only — disabled by default (catalystops.analysis.enableRepeatedScanDetection).
    if (options.enableRepeatedScanDetection) {
    //
    // A DataFrame read from a source (spark.read.*, spark.table(), spark.sql(),
    // spark.createDataFrame()) that triggers 2+ Spark actions without a
    // .cache()/.persist() boundary forces a full re-scan each time.
    //
    // Beyond tracking the original variable we follow:
    //   • Pure aliases:       df2 = df
    //   • Lazy derived vars:  df2 = df.filter(...)  /  df2 = df.select(...)
    // transitively — so actions on df2/df3/... count against the source's
    // scan tally. Lines that assign a new variable via a lazy transform are
    // NOT themselves counted as scans (they just extend the lineage set).
    {
        // Terminal PySpark methods that trigger a Spark job (force execution).
        const ACTION_RE = /\.(count|collect|show|take|first|toPandas|head|write\b|saveAsTable|writeTo|foreach(?:Partition)?|toLocalIterator|isEmpty|reduce)\s*[.(]/i;

        const srcRe = /^[ \t]*(\w+)\s*=\s*(?:\w+\.read\.|\bspark\.table\s*\(|\bspark\.sql\s*\(|\bspark\.createDataFrame\s*\()/gm;
        srcRe.lastIndex = 0;

        const sourceDefs: Array<{ varName: string; defLine: number; defCol: number; matchLen: number }> = [];
        let sm: RegExpExecArray | null;
        while ((sm = srcRe.exec(code)) !== null) {
            const varName = sm[1];
            const defOffset = sm.index;
            const defLine = code.substring(0, defOffset).split('\n').length - 1;
            const defLineText = lines[defLine] ?? '';
            if (defLineText.trim().startsWith('#')) { continue; }
            if (/# noqa: catalystops\b/i.test(defLineText)) { continue; }
            const defLineStart = code.lastIndexOf('\n', defOffset - 1) + 1;
            sourceDefs.push({ varName, defLine, defCol: defOffset - defLineStart, matchLen: sm[0].trimEnd().length });
        }

        for (const { varName, defLine, defCol, matchLen } of sourceDefs) {
            // tracked: all vars that transitively derive from this source
            // (starts with the source var itself; aliases + lazy-derived vars are added as we scan)
            const tracked = new Set<string>([varName]);
            const scanLines: number[] = [];
            let cacheFoundLine = -1;

            // Stop scanning if the primary source var is redefined from a new source
            const reDefRe = new RegExp(
                `^[ \\t]*${varName}\\s*=\\s*(?:\\w+\\.read\\.|\\bspark\\.table\\s*\\(|\\bspark\\.sql\\s*\\(|\\bspark\\.createDataFrame\\s*\\()`
            );

            for (let i = defLine + 1; i < lines.length; i++) {
                const lineText = lines[i];
                if (lineText.trim() === '' || lineText.trim().startsWith('#')) { continue; }
                if (/# noqa: catalystops\b/i.test(lineText)) { continue; }
                if (reDefRe.test(lineText)) { break; }

                // Fast skip: no tracked variable mentioned on this line at all
                let hasTrackedRef = false;
                for (const v of tracked) {
                    if (new RegExp(`\\b${v}\\b`).test(lineText)) { hasTrackedRef = true; break; }
                }
                if (!hasTrackedRef) { continue; }

                // cache/persist on any tracked var → record materialisation boundary, skip (not a scan)
                let isCacheLine = false;
                for (const v of tracked) {
                    if (new RegExp(`\\b${v}\\b\\.(?:cache|persist)\\s*\\(`).test(lineText)) {
                        if (cacheFoundLine === -1) { cacheFoundLine = i; }
                        isCacheLine = true;
                        break;
                    }
                }
                if (isCacheLine) { continue; }

                // Classify the line: managed (lazy alias/derived → extend lineage) or scan
                const hasAction = ACTION_RE.test(lineText);
                let isManagedLine = false;
                for (const v of tracked) {
                    // Pure alias:  new_var = v   (nothing after v except optional comment)
                    const aliasMatch = new RegExp(`^[ \\t]*(\\w+)\\s*=\\s*${v}\\s*(?:#|$)`).exec(lineText);
                    if (aliasMatch) {
                        if (!tracked.has(aliasMatch[1])) { tracked.add(aliasMatch[1]); }
                        isManagedLine = true;
                        break;
                    }

                    // Lazy derived:  new_var = v.lazy_method(  AND no action anywhere in the line.
                    // If an action method appears in the chain (e.g. df.filter(...).count())
                    // the whole expression is a scan, not a lazy build.
                    if (!hasAction) {
                        const derivedMatch = new RegExp(`^[ \\t]*(\\w+)\\s*=\\s*${v}\\.(\\w+)\\s*[\\[(]`).exec(lineText);
                        if (derivedMatch) {
                            const newVar = derivedMatch[1];
                            if (!tracked.has(newVar)) { tracked.add(newVar); }
                            isManagedLine = true;
                            break;
                        }
                    }
                }

                // General fallback: any assignment where a tracked var appears as an
                // argument (not the chain base) and no action fires is lazy.
                // Handles:  b = other_df.join(a, ...)
                //           result = some_func(a, b)
                // The LHS var derives transitively from the source — add it to tracked.
                if (!isManagedLine && !hasAction) {
                    const generalAssign = /^[ \t]*(\w+)\s*=/.exec(lineText);
                    if (generalAssign) {
                        const newVar = generalAssign[1];
                        if (!tracked.has(newVar)) { tracked.add(newVar); }
                        isManagedLine = true;
                    }
                }

                if (!isManagedLine) {
                    scanLines.push(i);
                }
            }

            if (scanLines.length < 2) { continue; }
            if (cacheFoundLine !== -1 && cacheFoundLine <= scanLines[1]) { continue; }

            issues.push({
                id: 'CODE_REPRO_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: `"${varName}" scanned ${scanLines.length}× — consider caching`,
                description: `"${varName}" is read from a source and used ${scanLines.length} times (lines ${scanLines.map(l => l + 1).join(', ')}) without .cache() or .persist(). Each use triggers a full re-scan of the underlying data, which can be very expensive on large datasets.`,
                fix: {
                    description: 'Call .cache() or .persist() immediately after reading the DataFrame',
                    code: `${varName} = spark.read.parquet("path")
${varName}.cache()   # materialise once — subsequent uses hit the in-memory cache

# Or inline:
${varName} = spark.read.parquet("path").cache()`,
                },
                line: defLine,
                column: defCol,
                endLine: defLine,
                endColumn: defCol + matchLen,
                location: `Line ${defLine + 1}`,
            });
        }
    }
    } // end enableRepeatedScanDetection

    // Missing ANALYZE TABLE after INSERT OVERWRITE or write.mode("overwrite"):
    // Without table statistics, the optimizer cannot make accurate decisions for
    // join ordering, broadcast thresholds, and partition pruning.
    {
        // Match write overwrite patterns: .mode("overwrite") ... .save/saveAsTable/insertInto() or SQL INSERT OVERWRITE
        const overwriteRe = /(?:\.mode\s*\(\s*["']overwrite["']\s*\)[\s\S]{0,300}?\.(?:saveAsTable|insertInto|save)\s*\(|INSERT\s+OVERWRITE\b)/gi;
        let owm: RegExpExecArray | null;
        while ((owm = overwriteRe.exec(code)) !== null) {
            const offset = owm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Look forward up to 5 lines for ANALYZE TABLE
            const ctxEnd = Math.min(lines.length - 1, lineNum + 5);
            const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');
            if (/\bANALYZE\s+TABLE\b/i.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_ANALYZE_001',
                severity: Severity.INFO,
                category: IssueCategory.CODE,
                title: 'No ANALYZE TABLE after overwrite — optimizer may lack statistics',
                description: 'After overwriting a table, the optimizer\'s column statistics are stale or absent. Without statistics, Spark cannot accurately estimate join sizes, choose broadcast thresholds, or prune partitions effectively. Run ANALYZE TABLE after large overwrites.',
                fix: {
                    description: 'Run ANALYZE TABLE after overwriting to refresh statistics',
                    code: `# After overwriting the table, refresh statistics:
df.write.mode("overwrite").saveAsTable("my_catalog.my_schema.my_table")
spark.sql("ANALYZE TABLE my_catalog.my_schema.my_table COMPUTE STATISTICS FOR ALL COLUMNS")

# For partitioned tables, also update partition stats:
spark.sql("ANALYZE TABLE my_catalog.my_schema.my_table COMPUTE STATISTICS FOR COLUMNS col1, col2")

# Note: For Unity Catalog managed tables, enable predictive optimization to
# handle this automatically:
# ALTER SCHEMA my_catalog.my_schema SET DBPROPERTIES ('delta.predictiveOptimization.enabled' = 'auto')`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + Math.min(owm[0].length, 60),
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // MERGE without delta.enableDeletionVectors: Deletion Vectors convert physical
    // deletes to soft-deletes, dramatically reducing write amplification on MERGE.
    // MERGE without delta.enableRowLevelConcurrency: Row-Level Concurrency allows
    // concurrent MERGE operations on the same table without full table locks.
    // Both are detected together since they're almost always set as a pair.
    {
        // Match SQL MERGE INTO or PySpark DeltaTable .merge() API
        // When DeltaTable is referenced, .alias(...).merge( is the idiomatic chained call.
        const hasDeltaTable = /\bDeltaTable\b/.test(code);
        const mergeRe2 = hasDeltaTable
            ? /\bMERGE\s+INTO\b|\.alias\s*\([^)]*\)\s*\.merge\s*\(/gi
            : /\bMERGE\s+INTO\b/gi;
        let m2: RegExpExecArray | null;
        // Only flag once per file — these are table-level settings
        let dvFlagged = false;
        let rlcFlagged = false;

        const hasDV = /delta\.enableDeletionVectors/i.test(code);
        const hasRLC = /delta\.enableRowLevelConcurrency/i.test(code);

        while ((m2 = mergeRe2.exec(code)) !== null) {
            const offset = m2.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            if (!hasDV && !dvFlagged) {
                dvFlagged = true;
                issues.push({
                    id: 'CODE_MERGE_DV_001',
                    severity: Severity.INFO,
                    category: IssueCategory.CODE,
                    title: 'MERGE without Deletion Vectors — enable for faster MERGE performance',
                    description: 'Without Deletion Vectors, every MERGE that deletes or updates rows must physically rewrite the affected data files. Deletion Vectors convert these to cheap soft-deletes (a small bitmap file), reducing write amplification significantly — often 5–10× faster on update-heavy MERGE workloads.',
                    fix: {
                        description: 'Enable Deletion Vectors on the MERGE target table',
                        code: `# Enable Deletion Vectors on the target table (one-time setup):
spark.sql("""
    ALTER TABLE my_catalog.my_schema.my_table
    SET TBLPROPERTIES ('delta.enableDeletionVectors' = 'true')
""")

# Also recommended for MERGE-heavy tables:
spark.sql("ALTER TABLE my_table SET TBLPROPERTIES ('delta.enableRowLevelConcurrency' = 'true')")
spark.sql("ALTER TABLE my_table CLUSTER BY (merge_key)")  # Liquid Clustering`,
                    },
                    line: lineNum,
                    column,
                    endLine: lineNum,
                    endColumn: column + m2[0].length,
                    location: `Line ${lineNum + 1}`,
                });
            }

            if (!hasRLC && !rlcFlagged) {
                rlcFlagged = true;
                issues.push({
                    id: 'CODE_MERGE_RLC_001',
                    severity: Severity.INFO,
                    category: IssueCategory.CODE,
                    title: 'MERGE without Row-Level Concurrency — enable for concurrent MERGE support',
                    description: 'Without Row-Level Concurrency, concurrent MERGE operations on the same table conflict at the file level, causing transaction retries or failures. Row-Level Concurrency allows multiple concurrent MERGEs that touch different rows to succeed without blocking each other.',
                    fix: {
                        description: 'Enable Row-Level Concurrency on the MERGE target table',
                        code: `# Enable Row-Level Concurrency (requires Deletion Vectors to also be enabled):
spark.sql("""
    ALTER TABLE my_catalog.my_schema.my_table
    SET TBLPROPERTIES (
        'delta.enableDeletionVectors' = 'true',
        'delta.enableRowLevelConcurrency' = 'true'
    )
""")`,
                    },
                    line: lineNum,
                    column,
                    endLine: lineNum,
                    endColumn: column + m2[0].length,
                    location: `Line ${lineNum + 1}`,
                });
            }

            if (dvFlagged && rlcFlagged) { break; }
        }
    }

    // Auto Loader stream without maxBytesPerTrigger: without this, Auto Loader
    // processes all available files in a single micro-batch, which can cause OOM
    // on first runs after a backlog accumulates.
    {
        // Detect Auto Loader via .format("cloudFiles") or the cloudFiles.format option
        const autoLoaderRe = /\.format\s*\(\s*["']cloudFiles["']\s*\)|\.option\s*\(\s*["']cloudFiles\.format["']/g;
        let alm: RegExpExecArray | null;
        while ((alm = autoLoaderRe.exec(code)) !== null) {
            const offset = alm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Look around the Auto Loader chain (±10 lines) for maxBytesPerTrigger
            const ctxStart = Math.max(0, lineNum - 5);
            const ctxEnd = Math.min(lines.length - 1, lineNum + 10);
            const ctxText = lines.slice(ctxStart, ctxEnd + 1).join('\n');
            if (/maxBytesPerTrigger/i.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_AUTOLOADER_RATE_001',
                severity: Severity.INFO,
                category: IssueCategory.CODE,
                title: 'Auto Loader stream without maxBytesPerTrigger — no backlog protection',
                description: 'Without maxBytesPerTrigger, Auto Loader processes all available files in a single micro-batch when a backlog exists (e.g. on first run or after downtime). This can cause executor OOM errors. Set maxBytesPerTrigger to cap the data volume processed per batch.',
                fix: {
                    description: 'Add maxBytesPerTrigger to control batch size',
                    code: `# Cap the data volume processed per micro-batch:
stream = (spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("maxBytesPerTrigger", "100m")  # ← add this (e.g. 100 MB per batch)
    .load(path))

# Rule of thumb: set to 100–500 MB for most workloads.
# Increase for high-throughput pipelines once you've validated memory usage.`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + alm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // RocksDB state store not configured for large stateful streaming operations:
    // The default in-memory state store is limited by executor heap. For large
    // state (> 10 GB or > 100M keys), RocksDB provides spill-to-disk support.
    if (/\breadStream\b/.test(code)) {
        const hasStateful = /\.groupBy\s*\(|\.dropDuplicates\s*\(|flatMapGroupsWithState|mapGroupsWithState/i.test(code);
        const hasRocksDB = /RocksDBStateProvider/i.test(code);

        if (hasStateful && !hasRocksDB) {
            // Flag on the first stateful op
            const statefulRe2 = /\.(?:groupBy|dropDuplicates)\s*\(|(?:flatMap|map)GroupsWithState/gi;
            let sfm2: RegExpExecArray | null;
            if ((sfm2 = statefulRe2.exec(code)) !== null) {
                const offset = sfm2.index;
                const lineNum = code.substring(0, offset).split('\n').length - 1;
                const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
                const column = offset - lineStart;
                const lineText = lines[lineNum] ?? '';
                if (!isInsideComment(lineText, column) && !/# noqa: catalystops\b/i.test(lineText)) {
                    issues.push({
                        id: 'CODE_ROCKSDB_001',
                        severity: Severity.INFO,
                        category: IssueCategory.CODE,
                        title: 'Stateful streaming without RocksDB — consider enabling for large state',
                        description: 'The default in-memory state store holds all state in executor heap. For large state stores (> 10 GB or > 100M keys), the heap fills up causing OOM failures. RocksDB state store spills to local disk and supports much larger state with minimal performance overhead.',
                        fix: {
                            description: 'Enable RocksDB state store for large stateful streaming operations',
                            code: `# Enable RocksDB state store (add to your Spark config or notebook init):
spark.conf.set(
    "spark.sql.streaming.stateStore.providerClass",
    "com.databricks.sql.streaming.state.RocksDBStateProvider"
)

# When to enable:
# - State store > 10 GB or > 100M unique keys
# - Shuffle spill > 0 on stateful stages
# - OOM errors on stateful streaming stages

# Start with default memory settings; tune if needed:
# spark.conf.set("spark.sql.streaming.stateStore.rocksdb.blockSizeKB", "4")`,
                        },
                        line: lineNum,
                        column,
                        endLine: lineNum,
                        endColumn: column + sfm2[0].length,
                        location: `Line ${lineNum + 1}`,
                    });
                }
            }
        }
    }

    // Streaming query without .trigger(): .writeStream chains that call .start()
    // without any .trigger( set run continuous micro-batches, causing excessive
    // cloud storage listing and unpredictable compute costs.
    {
        const writeStreamRe = /\.writeStream\b/g;
        let wsm: RegExpExecArray | null;
        while ((wsm = writeStreamRe.exec(code)) !== null) {
            const offset = wsm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Collect the chain: look forward up to 15 lines for .start()
            const ctxEnd = Math.min(lines.length - 1, lineNum + 15);
            const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');

            // Must have .start() to confirm this is an active streaming write
            if (!(/\.start\s*\(\s*\)/.test(ctxText))) { continue; }
            // Skip if a trigger is already specified
            if (/\.trigger\s*\(/.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_STREAM_TRIGGER_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: 'Streaming query has no .trigger() — continuous micro-batches',
                description: 'Without .trigger(), Spark runs continuous micro-batches as fast as possible, causing excessive cloud storage listing, high compute costs, and unpredictable latency. Set an interval appropriate for your SLA (rule of thumb: SLA ÷ 3, minimum 30 s). Use .trigger(availableNow=True) for scheduled batch-style processing (cheapest option).',
                fix: {
                    description: 'Add .trigger(processingTime=...) or .trigger(availableNow=True) to control batch cadence',
                    code: `# Fixed interval (SLA ÷ 3 — e.g. 20 min trigger for 1-hour SLA):
df.writeStream \\
    .trigger(processingTime="5 minutes") \\
    .format("delta") \\
    .option("checkpointLocation", path) \\
    .start()

# Batch-style (cheapest — run once, then stop):
df.writeStream \\
    .trigger(availableNow=True) \\
    .format("delta") \\
    .option("checkpointLocation", path) \\
    .start()`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + wsm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // Stateful streaming aggregation without watermark: .groupBy() on a streaming
    // DataFrame without a preceding .withWatermark() causes the state store to grow
    // unbounded, eventually causing OOM failures.
    if (/\breadStream\b/.test(code)) {
        const groupByRe = /\.groupBy\s*\(/g;
        let gbm: RegExpExecArray | null;
        while ((gbm = groupByRe.exec(code)) !== null) {
            const offset = gbm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Look back up to 10 lines for .withWatermark( in the same chain
            const ctxStart = Math.max(0, lineNum - 10);
            const ctxText = lines.slice(ctxStart, lineNum + 1).join('\n');
            if (/\.withWatermark\s*\(/.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_STREAM_WATERMARK_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: 'Streaming groupBy() without .withWatermark() — unbounded state',
                description: 'Streaming aggregations with groupBy() maintain state for every key seen. Without .withWatermark(), that state grows indefinitely and will eventually exhaust executor memory. Always use .withWatermark() to define how long late data is accepted and bound the state store size.',
                fix: {
                    description: 'Add .withWatermark() before groupBy() to bound the state store',
                    code: `# Instead of:
df.groupBy("user_id").agg(F.count("*"))  # state grows forever

# Add withWatermark to expire old state:
df.withWatermark("event_time", "1 hour") \\
    .groupBy(
        F.window("event_time", "10 minutes"),
        "user_id"
    ).agg(F.count("*"))

# Rule of thumb: set watermark to 2–3× your p95 event latency.
# Enable RocksDB for large state stores (> 100M keys or > 10 GB):
# spark.conf.set(
#     "spark.sql.streaming.stateStore.providerClass",
#     "com.databricks.sql.streaming.state.RocksDBStateProvider"
# )`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + gbm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // DROP TABLE followed by CREATE TABLE: breaks concurrent readers and loses
    // time-travel history. CREATE OR REPLACE TABLE is atomic and safe.
    {
        const dropRe = /\bDROP\s+TABLE\b/gi;
        let dm: RegExpExecArray | null;
        while ((dm = dropRe.exec(code)) !== null) {
            const offset = dm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Look forward up to 5 lines for CREATE TABLE
            const ctxEnd = Math.min(lines.length - 1, lineNum + 5);
            const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');
            if (!/\bCREATE\s+TABLE\b/i.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_DROP_CREATE_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: 'DROP TABLE + CREATE TABLE — use CREATE OR REPLACE TABLE instead',
                description: 'DROP TABLE followed by CREATE TABLE is non-atomic: concurrent readers see a missing table between the two statements, time-travel history is permanently deleted, and any failure between the two statements leaves no table at all. CREATE OR REPLACE TABLE is a single atomic operation that preserves readers and history.',
                fix: {
                    description: 'Replace DROP TABLE + CREATE TABLE with CREATE OR REPLACE TABLE',
                    code: `# Instead of:
spark.sql("DROP TABLE IF EXISTS my_catalog.my_schema.my_table")
spark.sql("""
    CREATE TABLE my_catalog.my_schema.my_table (
        id BIGINT, name STRING
    ) USING DELTA
""")

# Use (atomic, preserves time travel, safe for concurrent readers):
spark.sql("""
    CREATE OR REPLACE TABLE my_catalog.my_schema.my_table (
        id BIGINT, name STRING
    ) USING DELTA
""")`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + dm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // Streaming query without a queryName option: unnamed queries are hard to
    // identify in the Spark UI and structured streaming metrics.
    {
        const writeStreamRe2 = /\.writeStream\b/g;
        let wsm2: RegExpExecArray | null;
        while ((wsm2 = writeStreamRe2.exec(code)) !== null) {
            const offset = wsm2.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            const ctxEnd = Math.min(lines.length - 1, lineNum + 15);
            const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');
            if (!(/\.start\s*\(\s*\)/.test(ctxText))) { continue; }
            if (/\.option\s*\(\s*["']queryName["']/.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_STREAM_QUERYNAME_001',
                severity: Severity.INFO,
                category: IssueCategory.CODE,
                title: 'Streaming query has no queryName — hard to identify in Spark UI',
                description: 'Streaming queries without a queryName are listed as random UUIDs in the Spark UI, structured streaming metrics, and logs. Adding a descriptive queryName makes it easy to identify, monitor, and alert on specific streams.',
                fix: {
                    description: 'Add .option("queryName", "...") to the writeStream chain',
                    code: `df.writeStream \\
    .option("queryName", "events_to_silver")  # ← add a descriptive name
    .trigger(processingTime="5 minutes") \\
    .format("delta") \\
    .option("checkpointLocation", path) \\
    .start()`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + wsm2[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // FLOAT/DOUBLE for columns with financial names: floating-point types cause
    // precision errors that silently corrupt financial calculations.
    {
        const financialNames = /\b(?:price|amount|revenue|cost|fee|total|balance|salary|rate|tax|discount|charge|payment|income|profit|loss|budget|spend|spending)\b/i;
        // Match StructField("col_name", FloatType()) or StructField("col_name", DoubleType())
        const floatFieldRe = /StructField\s*\(\s*["'](\w+)["']\s*,\s*(?:Float|Double)Type\s*\(\s*\)/gi;
        let ffm: RegExpExecArray | null;
        while ((ffm = floatFieldRe.exec(code)) !== null) {
            const colName = ffm[1];
            if (!financialNames.test(colName)) { continue; }
            const offset = ffm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            issues.push({
                id: 'CODE_FLOAT_FINANCIAL_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: `FLOAT/DOUBLE for financial column "${colName}" — use DECIMAL instead`,
                description: `FloatType and DoubleType use binary floating-point representation, which cannot exactly represent most decimal fractions. This causes silent rounding errors in financial calculations (e.g. 0.1 + 0.2 ≠ 0.3). Use DecimalType for all monetary and financial values.`,
                fix: {
                    description: 'Replace FloatType/DoubleType with DecimalType(precision, scale) for financial columns',
                    code: `# Instead of:
StructField("${colName}", FloatType())   # binary float — imprecise
StructField("${colName}", DoubleType())  # binary float — imprecise

# Use:
StructField("${colName}", DecimalType(18, 2))  # exact decimal — 18 digits, 2 decimal places

# In SQL DDL:
${colName} DECIMAL(18, 2)`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + ffm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // OPTIMIZE immediately after MERGE in foreachBatch: running OPTIMIZE after
    // every micro-batch introduces full-table compaction latency on every batch.
    // Liquid Clustering compacts incrementally without needing manual OPTIMIZE.
    {
        const mergeRe = /\bMERGE\s+INTO\b/gi;
        let mrgm: RegExpExecArray | null;
        while ((mrgm = mergeRe.exec(code)) !== null) {
            const offset = mrgm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Look forward up to 5 lines for OPTIMIZE
            const ctxEnd = Math.min(lines.length - 1, lineNum + 5);
            const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');
            if (!/\bOPTIMIZE\b/i.test(ctxText)) { continue; }

            issues.push({
                id: 'CODE_MERGE_OPTIMIZE_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: 'OPTIMIZE after every MERGE — causes latency spikes per batch',
                description: 'Running OPTIMIZE after each MERGE batch triggers a full compaction pass on every micro-batch, adding significant latency. Enable Liquid Clustering on the target table so Delta handles compaction incrementally and automatically — no manual OPTIMIZE needed.',
                fix: {
                    description: 'Enable Liquid Clustering and remove per-batch OPTIMIZE calls',
                    code: `# Remove per-batch OPTIMIZE:
# spark.sql(f"OPTIMIZE {target_table}")  ← remove this

# Enable Liquid Clustering on the target table (one-time setup):
spark.sql("""
    ALTER TABLE my_catalog.my_schema.my_table
    CLUSTER BY (merge_key, event_date)
""")

# Also enable the modern Delta stack for best MERGE performance:
spark.sql("ALTER TABLE my_table SET TBLPROPERTIES ('delta.enableDeletionVectors' = 'true')")
spark.sql("ALTER TABLE my_table SET TBLPROPERTIES ('delta.enableRowLevelConcurrency' = 'true')")`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + mrgm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // Inner join in stream-static context: .join(...) without "left" in a file
    // that has readStream silently drops streaming events with no matching dimension
    // record. Use left join to preserve all streaming events.
    if (/\breadStream\b/.test(code)) {
        const joinRe = /\.join\s*\(\s*\w+\s*,/g;
        let jm: RegExpExecArray | null;
        while ((jm = joinRe.exec(code)) !== null) {
            const offset = jm.index;
            const lineNum = code.substring(0, offset).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
            const column = offset - lineStart;
            const lineText = lines[lineNum] ?? '';
            if (isInsideComment(lineText, column)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Look at the join call context (up to 3 lines) for join type
            const ctxEnd = Math.min(lines.length - 1, lineNum + 3);
            const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');

            // Skip if a non-inner join type is explicitly specified
            if (/\b(?:left|right|outer|full|left_outer|leftouter|cross|semi|anti)\b/i.test(ctxText)) { continue; }
            // Skip if this is a stream-stream join (both sides streaming — different rules)
            // We can't easily detect this statically, so only flag when stream-static pattern is likely

            issues.push({
                id: 'CODE_STREAM_JOIN_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: 'Inner join in streaming context may silently drop events',
                description: 'In a stream-static join, an inner join silently drops streaming events that have no matching record in the dimension table at the time of processing. Late-arriving dimension records can never recover those dropped events. Use a left join to preserve all streaming events, then handle nulls downstream.',
                fix: {
                    description: 'Use left join to preserve all streaming events; handle null dimension columns downstream',
                    code: `# Instead of (silently drops unmatched events):
enriched = stream_df.join(dim_df, on="customer_id")

# Use left join (preserves all events):
enriched = stream_df.join(dim_df, on="customer_id", how="left")

# Monitor null rates to detect unmatched events:
# enriched.filter(F.col("dim_column").isNull()).count()

# Schedule a daily backfill MERGE to fix historical nulls once
# the dimension record arrives.`,
                },
                line: lineNum,
                column,
                endLine: lineNum,
                endColumn: column + jm[0].length,
                location: `Line ${lineNum + 1}`,
            });
        }
    }

    // ── DLT / Spark Declarative Pipelines checks ─────────────────────────────
    // These only fire when the file uses DLT syntax (dlt.table / @dp.table / APPLY CHANGES INTO).
    const isDltFile = /@(?:dlt|dp)\.(?:table|view|temporary_view|expect|expect_or_drop|expect_or_fail)|APPLY\s+CHANGES\s+INTO\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:STREAMING\s+)?(?:LIVE|MATERIALIZED VIEW)\b/i.test(code);

    if (isDltFile) {
        // DLT: PARTITION BY on a DLT table instead of CLUSTER BY
        // DLT tables should use Liquid Clustering (CLUSTER BY), not traditional
        // partition columns (PARTITION BY), which creates fixed-layout partitions.
        {
            // Match SQL PARTITION BY / PARTITIONED BY and Python DLT partition_cols= kwarg
            const dltPartRe = /\bPARTITION(?:ED)?\s+BY\b|\bpartition_cols\s*=/gi;
            let dpm: RegExpExecArray | null;
            while ((dpm = dltPartRe.exec(code)) !== null) {
                const offset = dpm.index;
                const lineNum = code.substring(0, offset).split('\n').length - 1;
                const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
                const column = offset - lineStart;
                const lineText = lines[lineNum] ?? '';
                if (isInsideComment(lineText, column)) { continue; }
                if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

                issues.push({
                    id: 'CODE_DLT_PARTITION_001',
                    severity: Severity.WARNING,
                    category: IssueCategory.CODE,
                    title: 'DLT table uses PARTITION BY — use CLUSTER BY (Liquid Clustering) instead',
                    description: 'PARTITION BY creates fixed-layout partitions that require manual OPTIMIZE runs and degrade performance when partition cardinality is high. Liquid Clustering (CLUSTER BY) automatically compacts data incrementally and does not require OPTIMIZE. It replaces both PARTITION BY and ZORDER BY for DLT tables.',
                    fix: {
                        description: 'Replace PARTITION BY with CLUSTER BY in your DLT table definition',
                        code: `# Instead of:
@dlt.table(
    partition_cols=["event_date"]  # fixed partitions
)

# Use:
@dlt.table(
    cluster_by=["event_date", "event_type"]  # Liquid Clustering — limit to 1–4 keys
)

# In SQL:
-- Instead of:  PARTITIONED BY (event_date)
-- Use:         CLUSTER BY (event_date, event_type)`,
                    },
                    line: lineNum,
                    column,
                    endLine: lineNum,
                    endColumn: column + dpm[0].length,
                    location: `Line ${lineNum + 1}`,
                });
            }
        }

        // DLT: SELECT * in a Materialized View — reads all columns unnecessarily
        {
            const dltSelectStarRe = /\bSELECT\s+\*/gi;
            let dssm: RegExpExecArray | null;
            while ((dssm = dltSelectStarRe.exec(code)) !== null) {
                const offset = dssm.index;
                const lineNum = code.substring(0, offset).split('\n').length - 1;
                const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
                const column = offset - lineStart;
                const lineText = lines[lineNum] ?? '';
                if (isInsideComment(lineText, column)) { continue; }
                if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

                issues.push({
                    id: 'CODE_DLT_SELECT_STAR_001',
                    severity: Severity.INFO,
                    category: IssueCategory.CODE,
                    title: 'SELECT * in DLT pipeline — select only needed columns',
                    description: 'SELECT * reads all columns from the source, including columns that downstream consumers do not use. Selecting only needed columns reduces I/O, storage, and Liquid Clustering effectiveness (clustering works best on a focused column set).',
                    fix: {
                        description: 'List only the columns your downstream consumers need',
                        code: `-- Instead of:
SELECT * FROM LIVE.source_table

-- Select specific columns:
SELECT
    event_id,
    user_id,
    event_time,
    event_type,
    payload
FROM LIVE.source_table`,
                    },
                    line: lineNum,
                    column,
                    endLine: lineNum,
                    endColumn: column + dssm[0].length,
                    location: `Line ${lineNum + 1}`,
                });
            }
        }

        // DLT: Missing schemaHints on read_files() — schema inference in production
        // reads all files to infer schema, causing slow startup and schema drift.
        {
            const readFilesRe = /\bread_files\s*\(/g;
            let rfm: RegExpExecArray | null;
            while ((rfm = readFilesRe.exec(code)) !== null) {
                const offset = rfm.index;
                const lineNum = code.substring(0, offset).split('\n').length - 1;
                const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
                const column = offset - lineStart;
                const lineText = lines[lineNum] ?? '';
                if (isInsideComment(lineText, column)) { continue; }
                if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

                // Look for schemaHints within the read_files call (up to 5 lines)
                const ctxEnd = Math.min(lines.length - 1, lineNum + 5);
                const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');
                if (/schemaHints/i.test(ctxText)) { continue; }

                issues.push({
                    id: 'CODE_DLT_SCHEMA_HINTS_001',
                    severity: Severity.WARNING,
                    category: IssueCategory.CODE,
                    title: 'read_files() without schemaHints — schema drift risk in production',
                    description: 'read_files() without schemaHints relies on full schema inference, which scans all files on startup and is vulnerable to schema drift (a new upstream field with an incompatible type breaks the pipeline). Provide schemaHints to pin critical column types while still allowing new columns to be added.',
                    fix: {
                        description: 'Add schemaHints to explicitly type the critical columns',
                        code: `-- Instead of (full inference — slow and fragile):
SELECT * FROM read_files("s3://bucket/events/", format => "json")

-- Use schemaHints to anchor critical column types:
SELECT * FROM read_files(
    "s3://bucket/events/",
    format => "json",
    schemaHints => "event_id BIGINT, user_id STRING, event_time TIMESTAMP, amount DECIMAL(18,2)"
)
-- New columns not in schemaHints are still inferred — no need to list every column.`,
                    },
                    line: lineNum,
                    column,
                    endLine: lineNum,
                    endColumn: column + rfm[0].length,
                    location: `Line ${lineNum + 1}`,
                });
            }
        }

        // DLT AUTO CDC: APPLY AS DELETE WHEN after SEQUENCE BY — wrong order
        // The correct order is: APPLY AS DELETE WHEN before SEQUENCE BY.
        {
            const applyChangesRe = /\bAPPLY\s+CHANGES\s+INTO\b/gi;
            let acm: RegExpExecArray | null;
            while ((acm = applyChangesRe.exec(code)) !== null) {
                const offset = acm.index;
                const lineNum = code.substring(0, offset).split('\n').length - 1;

                // Collect the full APPLY CHANGES block (up to 20 lines)
                const ctxEnd = Math.min(lines.length - 1, lineNum + 20);
                const ctxText = lines.slice(lineNum, ctxEnd + 1).join('\n');

                if (!/APPLY\s+AS\s+DELETE\s+WHEN/i.test(ctxText)) { continue; }
                if (!/SEQUENCE\s+BY/i.test(ctxText)) { continue; }

                // Flag if DELETE WHEN appears after SEQUENCE BY in the block
                const seqIdx = ctxText.search(/SEQUENCE\s+BY/i);
                const delIdx = ctxText.search(/APPLY\s+AS\s+DELETE\s+WHEN/i);
                if (delIdx <= seqIdx) { continue; } // correct order — skip

                const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
                const column = offset - lineStart;
                const lineText = lines[lineNum] ?? '';
                if (isInsideComment(lineText, column)) { continue; }
                if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

                issues.push({
                    id: 'CODE_DLT_CDC_ORDER_001',
                    severity: Severity.CRITICAL,
                    category: IssueCategory.CODE,
                    title: 'APPLY AS DELETE WHEN after SEQUENCE BY — wrong clause order in AUTO CDC',
                    description: 'In APPLY CHANGES INTO, APPLY AS DELETE WHEN must appear before SEQUENCE BY. Placing it after SEQUENCE BY causes a syntax error or incorrect CDC behavior where deletes are not applied.',
                    fix: {
                        description: 'Move APPLY AS DELETE WHEN before SEQUENCE BY',
                        code: `-- Correct clause order:
APPLY CHANGES INTO
    LIVE.target_table
FROM
    STREAM(LIVE.source_cdc)
KEYS (id)
APPLY AS DELETE WHEN operation = "DELETE"  -- ← must come BEFORE SEQUENCE BY
SEQUENCE BY updated_at
COLUMNS * EXCEPT (operation, updated_at)`,
                    },
                    line: lineNum,
                    column,
                    endLine: lineNum,
                    endColumn: column + acm[0].length,
                    location: `Line ${lineNum + 1}`,
                });
            }
        }

        // DLT: CLUSTER BY AUTO in production — explicit keys outperform AUTO
        // for tables under 10 TB where query patterns are known.
        {
            const clusterAutoRe = /\bCLUSTER\s+BY\s+AUTO\b/gi;
            let cam: RegExpExecArray | null;
            while ((cam = clusterAutoRe.exec(code)) !== null) {
                const offset = cam.index;
                const lineNum = code.substring(0, offset).split('\n').length - 1;
                const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
                const column = offset - lineStart;
                const lineText = lines[lineNum] ?? '';
                if (isInsideComment(lineText, column)) { continue; }
                if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

                issues.push({
                    id: 'CODE_DLT_CLUSTER_AUTO_001',
                    severity: Severity.INFO,
                    category: IssueCategory.CODE,
                    title: 'CLUSTER BY AUTO in production — consider explicit cluster keys',
                    description: 'CLUSTER BY AUTO is useful for prototyping, but for production tables (especially under 10 TB) explicit cluster keys chosen to match your query filter patterns will outperform AUTO. AUTO adds overhead from analyzing query statistics to infer keys and may choose suboptimal columns.',
                    fix: {
                        description: 'Replace CLUSTER BY AUTO with explicit cluster keys based on your filter patterns',
                        code: `-- Instead of:
CLUSTER BY AUTO

-- Use explicit keys that match your most common filter columns:
CLUSTER BY (event_date, user_id)

-- Guidelines:
-- • 1–4 cluster keys (2 often outperform 4 for tables under 10 TB)
-- • Choose columns you filter on most frequently (WHERE, JOIN ON, GROUP BY)
-- • Prefer low-to-medium cardinality: date, region, event_type — not user_id or UUID`,
                    },
                    line: lineNum,
                    column,
                    endLine: lineNum,
                    endColumn: column + cam[0].length,
                    location: `Line ${lineNum + 1}`,
                });
            }
        }
    }

    // Schema validation: column name and type checks
    const schemaIssues = validateSchema(code);
    issues.push(...schemaIssues);

    return issues;
}

/**
 * Get documentation for all anti-patterns.
 */
export function getPatternDocumentation(): Array<{ id: string; name: string; description: string }> {
    return antiPatterns.map(p => ({ id: p.id, name: p.name, description: p.description }));
}
