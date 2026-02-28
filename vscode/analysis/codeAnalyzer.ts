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
        severity: Severity.WARNING,
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
        id: 'CODE_WITHCOL_LOOP_001',
        name: 'withColumn in Loop',
        pattern: /for\s+\w+\s+in\s+.+:\s*\n(?:[^\n]*\n)*?\s*(?:\w+\s*=\s*\w+\.withColumn|\.withColumn)/gm,
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
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
export function analyzeCode(code: string): CodeIssue[] {
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
