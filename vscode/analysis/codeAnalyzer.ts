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
