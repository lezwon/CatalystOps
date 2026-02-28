/**
 * Tests for the Schema Validator — SCHEMA_COL_001 and SCHEMA_TYPE_001 checks.
 */

import * as assert from 'assert';
import {
    findMatchingParen,
    parseStructType,
    extractStructTypeSchemas,
    parseDdlSchema,
    extractDdlSchemas,
    levenshtein,
    suggestColumns,
} from '../../vscode/analysis/schemaExtractor';
import { buildDfSchemaMap, schemaAtLine } from '../../vscode/analysis/schemaTracker';
import { validateSchema } from '../../vscode/analysis/schemaValidator';

// ── 1. Schema Extraction (StructType) ─────────────────────────────────────────

suite('Schema Extraction — StructType', () => {
    test('single-line StructType extracts all fields', () => {
        const code = `schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])`;
        const map = extractStructTypeSchemas(code);
        const fields = map.get('schema')?.[0]?.schema;
        assert.ok(fields, 'schema variable should be extracted');
        assert.strictEqual(fields!.length, 2);
        assert.deepStrictEqual(fields![0], { name: 'id', type: 'integer' });
        assert.deepStrictEqual(fields![1], { name: 'name', type: 'string' });
    });

    test('multi-line StructType is parsed correctly', () => {
        const code = `
schema = StructType([
    StructField("user_id", LongType()),
    StructField("amount", DoubleType()),
    StructField("active", BooleanType()),
])
`.trim();
        const map = extractStructTypeSchemas(code);
        const fields = map.get('schema')?.[0]?.schema;
        assert.ok(fields, 'should parse multi-line StructType');
        assert.strictEqual(fields!.length, 3);
        assert.deepStrictEqual(fields![0], { name: 'user_id', type: 'long' });
        assert.deepStrictEqual(fields![1], { name: 'amount', type: 'double' });
        assert.deepStrictEqual(fields![2], { name: 'active', type: 'boolean' });
    });

    test('multiple schema variables are extracted independently', () => {
        const code = `
s1 = StructType([StructField("a", StringType())])
s2 = StructType([StructField("b", IntegerType()), StructField("c", FloatType())])
`.trim();
        const map = extractStructTypeSchemas(code);
        assert.strictEqual(map.get('s1')![0].schema.length, 1);
        assert.strictEqual(map.get('s2')![0].schema.length, 2);
    });

    test('StructType with fields= keyword argument is parsed', () => {
        const code = `my_schema = StructType(fields=[StructField("ts", TimestampType()), StructField("val", DoubleType())])`;
        const map = extractStructTypeSchemas(code);
        const fields = map.get('my_schema')?.[0]?.schema;
        assert.ok(fields, 'should extract named-fields syntax');
        assert.strictEqual(fields!.length, 2);
        assert.strictEqual(fields![0].type, 'timestamp');
    });

    test('StructType variable referenced in createDataFrame is found', () => {
        const code = `
schema = StructType([StructField("user_id", IntegerType()), StructField("name", StringType())])
df = spark.createDataFrame(data, schema)
`.trim();
        const struct = extractStructTypeSchemas(code);
        const ddl    = extractDdlSchemas(code);
        const history = buildDfSchemaMap(code, struct, ddl);
        const schema = schemaAtLine(history, 'df', 1);
        assert.ok(schema, 'df should have schema from variable reference');
        assert.strictEqual(schema!.length, 2);
        assert.strictEqual(schema![0].name, 'user_id');
    });
});

// ── 2. Schema Extraction (DDL) ────────────────────────────────────────────────

suite('Schema Extraction — DDL', () => {
    test('inline DDL string in createDataFrame is parsed', () => {
        const code = `df = spark.createDataFrame(data, "id INT, name STRING, ts TIMESTAMP")`;
        const struct = extractStructTypeSchemas(code);
        const ddl    = extractDdlSchemas(code);
        const history = buildDfSchemaMap(code, struct, ddl);
        const schema = schemaAtLine(history, 'df', 0);
        assert.ok(schema, 'should parse inline DDL schema');
        assert.strictEqual(schema!.length, 3);
        assert.deepStrictEqual(schema![0], { name: 'id', type: 'integer' });
        assert.deepStrictEqual(schema![1], { name: 'name', type: 'string' });
        assert.deepStrictEqual(schema![2], { name: 'ts', type: 'timestamp' });
    });

    test('createDataFrame with schema= keyword argument is recognised', () => {
        const code = `
schema = StructType([StructField("name", StringType()), StructField("age", IntegerType())])
df = spark.createDataFrame([("Alice", 30), ("Bob", 25)], ["name", "age"], schema=schema)
df.select("d")
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"d"')),
            'unknown column should be flagged when schema is passed as keyword arg');
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"name"')).length, 0,
            'valid column "name" should not be flagged');
    });

    test('spark.read.schema(var).json() is recognised', () => {
        const code = `
schema = StructType([StructField("name", StringType()), StructField("age", IntegerType())])
df = spark.read.schema(schema).json(path_list)
df.select("d")
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"d"')),
            'unknown column after spark.read.schema() should be flagged');
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"name"')).length, 0,
            'valid column "name" should not be flagged');
    });

    test('spark.read.schema(var).csv() valid column passes', () => {
        const code = `
schema = StructType([StructField("name", StringType()), StructField("age", IntegerType())])
df = spark.read.schema(schema).csv(path)
df.select("name")
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'valid column after spark.read.schema() should not be flagged');
    });

    test('DDL variable reference is resolved', () => {
        const code = `
ddl = "user_id BIGINT, score DOUBLE"
df = spark.createDataFrame(data, ddl)
`.trim();
        const struct = extractStructTypeSchemas(code);
        const ddl    = extractDdlSchemas(code);
        const history = buildDfSchemaMap(code, struct, ddl);
        const schema = schemaAtLine(history, 'df', 1);
        assert.ok(schema, 'should resolve DDL variable reference');
        assert.strictEqual(schema![0].type, 'long');
        assert.strictEqual(schema![1].type, 'double');
    });

    test('parseDdlSchema handles DECIMAL type', () => {
        const fields = parseDdlSchema('amount DECIMAL(10,2), name STRING');
        assert.strictEqual(fields[0].type, 'decimal');
        assert.strictEqual(fields[1].type, 'string');
    });

    test('non-DDL strings are not mistakenly treated as schemas', () => {
        const code = `greeting = "hello world"`;
        const map = extractDdlSchemas(code);
        assert.strictEqual(map.size, 0, 'non-DDL string should not be extracted');
    });
});

// ── 3. Column Validation ──────────────────────────────────────────────────────

suite('Column Validation', () => {
    const baseCode = `
from pyspark.sql.types import StructType, StructField, StringType, IntegerType

schema = StructType([
    StructField("user_id", IntegerType()),
    StructField("name", StringType()),
])
df = spark.createDataFrame(data, schema)
`.trim();

    test('valid column reference produces no issues', () => {
        const code = baseCode + '\ndf.select("user_id", "name")';
        const issues = validateSchema(code);
        const colIssues = issues.filter(i => i.id === 'SCHEMA_COL_001');
        assert.strictEqual(colIssues.length, 0, 'valid columns should not be flagged');
    });

    test('unknown column in select is flagged as SCHEMA_COL_001', () => {
        const code = baseCode + '\ndf.select("user_idd")';
        const issues = validateSchema(code);
        const colIssues = issues.filter(i => i.id === 'SCHEMA_COL_001');
        assert.strictEqual(colIssues.length, 1, 'typo in column name should be flagged');
        assert.ok(colIssues[0].title.includes('user_idd'), 'issue title should contain typo');
    });

    test('did-you-mean suggestion is correct', () => {
        const code = baseCode + '\ndf.select("user_idd")';
        const issues = validateSchema(code);
        const issue = issues.find(i => i.id === 'SCHEMA_COL_001');
        assert.ok(issue, 'issue should exist');
        assert.ok(issue!.description.includes('user_id'), 'suggestion should include "user_id"');
    });

    test('commented-out lines are not validated', () => {
        const code = baseCode + '\n# df.select("nonexistent_col")';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'commented-out code should not produce issues');
    });

    test('noqa suppression skips line', () => {
        const code = baseCode + '\ndf.select("nonexistent")  # noqa: catalystops';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'noqa line should be suppressed');
    });

    test('select("*") is not flagged', () => {
        const code = baseCode + '\ndf.select("*")';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'select("*") should not produce column issues');
    });

    test('groupBy with unknown column is flagged', () => {
        const code = baseCode + '\ndf.groupBy("nonexistent_col")';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001'), 'unknown groupBy column should be flagged');
    });

    test('drop with unknown column is flagged', () => {
        const code = baseCode + '\ndf.drop("bad_col")';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001'), 'unknown drop column should be flagged');
    });

    test('withColumnRenamed with unknown old name is flagged', () => {
        const code = baseCode + '\ndf.withColumnRenamed("typo_id", "correct_id")';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001'), 'unknown old column in rename should be flagged');
    });

    test('bracket access df["unknown"] is flagged', () => {
        const code = baseCode + '\ndf["nonexistent"]';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001'), 'unknown bracket access should be flagged');
    });
});

// ── 4. Type Validation ────────────────────────────────────────────────────────

suite('Type Validation', () => {
    const baseCode = `
schema = StructType([
    StructField("name", StringType()),
    StructField("amount", IntegerType()),
    StructField("created_at", TimestampType()),
])
df = spark.createDataFrame(data, schema)
`.trim();

    test('F.sum on string column is flagged as SCHEMA_TYPE_001', () => {
        const code = baseCode + '\ndf.agg(F.sum("name"))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'sum on string should be flagged');
    });

    test('F.sum on integer column passes', () => {
        const code = baseCode + '\ndf.agg(F.sum("amount"))';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_TYPE_001').length, 0,
            'sum on integer should not be flagged');
    });

    test('F.upper on date/timestamp column is flagged', () => {
        const code = baseCode + '\ndf.withColumn("x", F.upper("created_at"))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'upper on timestamp should be flagged');
    });

    test('F.upper on string column passes', () => {
        const code = baseCode + '\ndf.withColumn("x", F.upper("name"))';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_TYPE_001').length, 0,
            'upper on string should not be flagged');
    });

    test('F.year on string column is flagged', () => {
        const code = baseCode + '\ndf.select(F.year("name"))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'year on string should be flagged');
    });

    test('F.year on timestamp column passes', () => {
        const code = baseCode + '\ndf.select(F.year("created_at"))';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_TYPE_001').length, 0,
            'year on timestamp should not be flagged');
    });

    test('F.concat with col()-wrapped integer column is flagged', () => {
        const code = baseCode + '\ndf.select(F.concat(col("amount"), col("name")).alias("x"))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"amount"')),
            'concat on integer column should be flagged');
    });

    test('F.concat with two string columns passes', () => {
        const code = baseCode + '\ndf.select(F.concat(col("name"), col("name")).alias("x"))';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_TYPE_001').length, 0,
            'concat on string columns should not be flagged');
    });

    test('F.sum with col()-wrapped column is flagged when non-numeric', () => {
        const code = baseCode + '\ndf.agg(F.sum(col("name")))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"name"')),
            'sum via col() on string should be flagged');
    });

    test('F.sqrt on string column is flagged', () => {
        const code = baseCode + '\ndf.select(F.sqrt(col("name")))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"name"')),
            'sqrt on string column should be flagged');
    });

    test('F.sqrt on integer column passes', () => {
        const code = baseCode + '\ndf.select(F.sqrt(col("amount")))';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_TYPE_001').length, 0,
            'sqrt on integer column should not be flagged');
    });

    test('F.sin on string column is flagged', () => {
        const code = baseCode + '\ndf.select(F.sin(col("name")))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'sin on string should be flagged');
    });

    test('F.round on string column is flagged', () => {
        const code = baseCode + '\ndf.select(F.round(col("name"), 2))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'round on string should be flagged');
    });

    test('F.locate on integer column is flagged', () => {
        const code = baseCode + '\ndf.select(F.locate("e", col("amount")))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"amount"')),
            'locate on integer column should be flagged');
    });

    test('F.instr on integer column is flagged', () => {
        const code = baseCode + '\ndf.select(F.instr(col("amount"), "1"))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"amount"')),
            'instr on integer column should be flagged');
    });

    test('F.translate on integer column is flagged', () => {
        const code = baseCode + '\ndf.select(F.translate(col("amount"), "123", "abc"))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"amount"')),
            'translate on integer column should be flagged');
    });

    test('F.sum with col()-wrapped integer column passes', () => {
        const code = baseCode + '\ndf.agg(F.sum(col("amount")))';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_TYPE_001').length, 0,
            'sum via col() on integer should not be flagged');
    });

    test('bare string col dropped by prior select is flagged as SCHEMA_COL_001', () => {
        const code = baseCode + '\ndf2 = df.select("name")\ndf2.select(F.weekofyear("name"))';
        const issues = validateSchema(code);
        // df2 only has "name", which is string — weekofyear requires date, and name is still in schema
        // so this should be SCHEMA_TYPE_001 not SCHEMA_COL_001
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"name"')),
            'weekofyear on string column should be flagged as type error');
    });

    test('F.weekofyear with bare string col missing after select is flagged as SCHEMA_COL_001', () => {
        const code = baseCode + '\ndf2 = df.select("amount")\ndf2.select(F.weekofyear("name"))';
        const issues = validateSchema(code);
        // df2 only has "amount" — "name" no longer exists
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"name"')),
            'weekofyear on missing column should be flagged as unknown column');
    });

    test('F.locate literal string arg is not falsely flagged as unknown column', () => {
        const code = baseCode + '\ndf.select(F.locate("xyz", col("name")))';
        const issues = validateSchema(code);
        // "xyz" is a literal search string, not a column — should not produce SCHEMA_COL_001
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'literal arg to locate should not be flagged as unknown column');
    });

    test('F.explode on a non-array column is flagged', () => {
        const code = `
from pyspark.sql.types import StructType, StructField, StringType, ArrayType
schema = StructType([StructField("name", StringType()), StructField("tags", ArrayType(StringType()))])
df = spark.createDataFrame(data, schema)
df.select(F.explode("name"))
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"name"')),
            'explode on a string column should be flagged as SCHEMA_TYPE_001');
    });

    test('F.explode on an array column passes', () => {
        const code = `
from pyspark.sql.types import StructType, StructField, StringType, ArrayType
schema = StructType([StructField("name", StringType()), StructField("tags", ArrayType(StringType()))])
df = spark.createDataFrame(data, schema)
df.select(F.explode("tags"))
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'explode on an array column should not be flagged');
    });

    test('F.explode_outer on a non-array column is flagged', () => {
        const code = `
from pyspark.sql.types import StructType, StructField, IntegerType, ArrayType
schema = StructType([StructField("amount", IntegerType()), StructField("items", ArrayType(IntegerType()))])
df = spark.createDataFrame(data, schema)
df.select(F.explode_outer("amount"))
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"amount"')),
            'explode_outer on a non-array column should be flagged');
    });

    test('F.explode on unknown column emits SCHEMA_COL_001 not SCHEMA_TYPE_001', () => {
        const code = `
from pyspark.sql.types import StructType, StructField, StringType, ArrayType
schema = StructType([StructField("tags", ArrayType(StringType()))])
df = spark.createDataFrame(data, schema)
df.select(F.explode("typo_col"))
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001'), 'unknown column in explode should emit SCHEMA_COL_001');
        assert.ok(!issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'should not emit type error for unknown column');
    });
});

// ── 5. Schema Propagation ─────────────────────────────────────────────────────

suite('Schema Propagation', () => {
    const baseCode = `
schema = StructType([
    StructField("id", IntegerType()),
    StructField("name", StringType()),
    StructField("score", DoubleType()),
])
df = spark.createDataFrame(data, schema)
`.trim();

    test('filter preserves schema — valid column passes', () => {
        const code = baseCode + '\ndf2 = df.filter("id > 0")\ndf2.select("name")';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'filter should preserve schema and allow valid column');
    });

    test('select narrows schema — dropped column is then flagged', () => {
        const code = baseCode + '\ndf2 = df.select("id", "name")\ndf2.select("score")';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('score')),
            'column dropped by select should be flagged on subsequent access');
    });

    test('drop removes field from schema', () => {
        const code = baseCode + '\ndf2 = df.drop("score")\ndf2.select("score")';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('score')),
            'dropped column should be flagged on subsequent access');
    });

    test('withColumnRenamed renames field in schema', () => {
        const code = baseCode + '\ndf2 = df.withColumnRenamed("name", "full_name")\ndf2.select("full_name")';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'renamed column should be valid after renaming');
    });

    test('withColumnRenamed: old name no longer valid', () => {
        const code = baseCode + '\ndf2 = df.withColumnRenamed("name", "full_name")\ndf2.select("name")';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"name"')),
            'old column name should be invalid after rename');
    });

    test('withColumn adds new field — access is valid', () => {
        const code = baseCode + '\ndf2 = df.withColumn("new_col", df["id"] * 2)\ndf2.select("new_col")';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'column added by withColumn should be valid in subsequent access');
    });

    test('withColumn with typed function infers return type — type mismatch is caught', () => {
        const code = baseCode + '\ndf2 = df.withColumn("name_upper", F.upper(col("name")))\ndf2.select(F.weekofyear("name_upper"))';
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001' && i.description.includes('"name_upper"')),
            'weekofyear on a string column produced by F.upper should be flagged');
    });

    test('withColumn with typed function — correct type passes', () => {
        const code = baseCode + '\ndf2 = df.withColumn("name_upper", F.upper(col("name")))\ndf2.select(F.length("name_upper"))';
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_TYPE_001').length, 0,
            'length on a string column produced by F.upper should not be flagged');
    });
});

// ── 6. Edge Cases ─────────────────────────────────────────────────────────────

suite('Edge Cases', () => {
    test('code with no schema produces no issues', () => {
        const code = `
df = spark.read.parquet("path")
result = df.filter("x > 1").select("x", "y")
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.length, 0, 'no schema = no schema issues');
    });

    test('null schema after join produces no column issues', () => {
        const code = `
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df = spark.createDataFrame(data, schema)
df2 = df.join(other, "id")
df2.select("nonexistent_col")
`.trim();
        const issues = validateSchema(code);
        // After join, schema is null so no column validation should trigger
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'unknown schema after join should not produce false positives');
    });
});

// ── 7. Join Condition Validation ──────────────────────────────────────────────

suite('Join Condition Validation', () => {
    const makeCode = (joinLine: string) => `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("id", IntegerType()), StructField("score", DoubleType())])
df1 = spark.read.schema(schema1).json(path)
df2 = spark.read.schema(schema2).json(path)
${joinLine}
`.trim();

    test('valid string join key produces no issues', () => {
        const issues = validateSchema(makeCode('result = df1.join(df2, "id")'));
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'valid join key in both DFs should not be flagged');
    });

    test('string join key missing from left DF is flagged', () => {
        const issues = validateSchema(makeCode('result = df1.join(df2, "bad_col")'));
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"df1"') && i.description.includes('"bad_col"')),
            'unknown join key should be flagged against left DF');
    });

    test('string join key missing from right DF is flagged', () => {
        // "name" is in df1 but not df2
        const issues = validateSchema(makeCode('result = df1.join(df2, "name")'));
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"df2"') && i.description.includes('"name"')),
            'unknown join key should be flagged against right DF');
    });

    test('list join keys — valid keys produce no issues', () => {
        const issues = validateSchema(makeCode('result = df1.join(df2, ["id"])'));
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'valid list join key should not be flagged');
    });

    test('list join keys — bad key is flagged', () => {
        const issues = validateSchema(makeCode('result = df1.join(df2, ["id", "bad_col"])'));
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"bad_col"')),
            'invalid column in list join key should be flagged');
    });

    test('on= keyword argument is validated', () => {
        const issues = validateSchema(makeCode('result = df1.join(df2, how="left", on="bad_col")'));
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"bad_col"')),
            'on= keyword with unknown column should be flagged');
    });

    test('how= without on= does not produce false positives', () => {
        // No join condition to validate, just a how= arg
        const issues = validateSchema(makeCode('result = df1.join(df2, how="left")'));
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'join with only how= and no condition should not be flagged');
    });

    test('bracket-access join condition is not double-reported', () => {
        // df1["bad"] == df2["id"] — bad on left, valid on right
        // Should get exactly 1 issue (for df1["bad"]), not 2
        const issues = validateSchema(makeCode('result = df1.join(df2, df1["bad"] == df2["id"])'));
        const colIssues = issues.filter(i => i.id === 'SCHEMA_COL_001');
        assert.strictEqual(colIssues.length, 1, 'only the invalid bracket-access column should be flagged');
        assert.ok(colIssues[0].description.includes('"bad"'));
    });

    test('bracket-equality join condition with incompatible types is flagged as SCHEMA_JOIN_001', () => {
        // df["name"] (string) == df1_spark["col1"] (boolean) — should emit SCHEMA_JOIN_001
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', StringType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
result = df.join(df1_spark, df["name"] == df1_spark["col1"])
`.trim();
        const issues = validateSchema(code);
        const joinIssues = issues.filter(i => i.id === 'SCHEMA_JOIN_001');
        assert.strictEqual(joinIssues.length, 1, 'type mismatch in bracket-equality join should be flagged');
        assert.ok(joinIssues[0].description.includes('string'), 'description should mention string type');
        assert.ok(joinIssues[0].description.includes('boolean'), 'description should mention boolean type');
    });

    test('bracket-equality join condition with matching types produces no SCHEMA_JOIN_001', () => {
        const code = `
schema1 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
schema2 = StructType([StructField('name', StringType()), StructField('score', DoubleType())])
df1 = spark.createDataFrame(data, schema1)
df2 = spark.createDataFrame(data2, schema2)
result = df1.join(df2, df1["name"] == df2["name"])
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_JOIN_001').length, 0,
            'same types in bracket-equality join should not be flagged');
    });

    test('F.col() join condition does not flag column that belongs to right DataFrame', () => {
        // F.col("name") belongs to df (right), not df_spark (left) — should not be flagged
        const code = `
schema1 = StructType([StructField('col1', StringType()), StructField('col2', IntegerType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
joined_df = df_spark.join(df, F.col("col1") == F.col("name"))
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'F.col() referencing right DF column should not be flagged as unknown');
    });

    test('F.col() join condition still flags truly unknown column', () => {
        const code = `
schema1 = StructType([StructField('col1', StringType()), StructField('col2', IntegerType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
joined_df = df_spark.join(df, F.col("col1") == F.col("nonexistent"))
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 1,
            'column absent from both DataFrames should still be flagged');
        assert.ok(issues[0].description.includes('"nonexistent"'));
    });

    test('alias-qualified F.col() in join condition with matching types produces no issues', () => {
        // col2 is IntegerType in df1_spark; id is IntegerType in df — matching → no SCHEMA_JOIN_001
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', IntegerType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
joined_df = df1_spark.alias("a").join(df.alias("b"), F.col("a.col2") == F.col("b.id"), "outer")
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'alias-qualified column references should not be flagged as unknown');
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_JOIN_001').length, 0,
            'matching types should not produce a type mismatch');
    });

    test('attribute-access join condition with type mismatch is flagged as SCHEMA_JOIN_001', () => {
        // df.name is string, df1_spark.col1 is boolean → mismatch
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', StringType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
result = df1_spark.join(df, df.name == df1_spark.col1)
`.trim();
        const issues = validateSchema(code);
        const joinIssues = issues.filter(i => i.id === 'SCHEMA_JOIN_001');
        assert.strictEqual(joinIssues.length, 1, 'attribute-access type mismatch should be flagged');
        assert.ok(joinIssues[0].description.includes('string'), 'should mention string type');
        assert.ok(joinIssues[0].description.includes('boolean'), 'should mention boolean type');
    });

    test('attribute-access join condition with unknown column is flagged as SCHEMA_COL_001', () => {
        // col16 does not exist in df1_spark → should emit SCHEMA_COL_001
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', StringType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
result = df1_spark.join(df, df.name == df1_spark.col16)
`.trim();
        const issues = validateSchema(code);
        const colIssues = issues.filter(i => i.id === 'SCHEMA_COL_001');
        assert.strictEqual(colIssues.length, 1, 'unknown column in attribute-access join should be flagged');
        assert.ok(colIssues[0].description.includes('"col16"'));
    });

    test('SCHEMA_JOIN_001 issue has line-relative column position', () => {
        // The column and endColumn must be within the line length (not absolute code offsets)
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', StringType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
result = df1_spark.join(df, df.name == df1_spark.col1)
`.trim();
        const issues = validateSchema(code);
        const joinIssues = issues.filter(i => i.id === 'SCHEMA_JOIN_001');
        assert.strictEqual(joinIssues.length, 1);
        const issue = joinIssues[0];
        const lineText = code.split('\n')[issue.line];
        assert.ok(issue.column >= 0, 'column should be non-negative');
        assert.ok(issue.column < lineText.length, `column ${issue.column} should be within line length ${lineText.length}`);
        assert.ok((issue.endColumn ?? 0) <= lineText.length, `endColumn should not exceed line length`);
    });

    test('unqualified F.col() join condition with type mismatch is flagged as SCHEMA_JOIN_001', () => {
        // col1 is boolean in df1_spark, name is string in df → mismatch
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', StringType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
joined_df = df1_spark.join(df, F.col("col1") == F.col("name"))
`.trim();
        const issues = validateSchema(code);
        const joinIssues = issues.filter(i => i.id === 'SCHEMA_JOIN_001');
        assert.strictEqual(joinIssues.length, 1, 'unqualified F.col() type mismatch should be flagged');
        assert.ok(joinIssues[0].description.includes('boolean'), 'should mention boolean type');
        assert.ok(joinIssues[0].description.includes('string'), 'should mention string type');
    });

    test('alias-qualified F.col() join condition with type mismatch is flagged as SCHEMA_JOIN_001', () => {
        // col1 is boolean in df1_spark (alias "a"), name is string in df (alias "b") → mismatch
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', StringType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
joined_df = df1_spark.alias("a").join(df.alias("b"), F.col("a.col1") == F.col("b.name"), "outer")
`.trim();
        const issues = validateSchema(code);
        const joinIssues = issues.filter(i => i.id === 'SCHEMA_JOIN_001');
        assert.strictEqual(joinIssues.length, 1, 'alias-qualified F.col() type mismatch should be flagged');
        assert.ok(joinIssues[0].description.includes('boolean'), 'should mention boolean type');
        assert.ok(joinIssues[0].description.includes('string'), 'should mention string type');
    });

    test('alias-qualified multi-line F.col() join condition with type mismatch is flagged', () => {
        // Same as above but join spans multiple lines (paren continuation)
        const code = `
schema1 = StructType([StructField('col1', BooleanType()), StructField('col2', StringType())])
schema2 = StructType([StructField('name', StringType()), StructField('id', IntegerType())])
df1_spark = spark.createDataFrame(data, schema1)
df = spark.createDataFrame(data2, schema2)
joined_df = df1_spark.alias("a").join(
    df.alias("b"), F.col("a.col1") == F.col("b.name"), "outer"
)
`.trim();
        const issues = validateSchema(code);
        const joinIssues = issues.filter(i => i.id === 'SCHEMA_JOIN_001');
        assert.strictEqual(joinIssues.length, 1, 'multi-line alias-qualified type mismatch should be flagged');
        assert.ok(joinIssues[0].description.includes('boolean'));
        assert.ok(joinIssues[0].description.includes('string'));
    });

    test('right DF with no known schema skips right-side check silently', () => {
        const code = `
schema1 = StructType([StructField("id", IntegerType())])
df1 = spark.read.schema(schema1).json(path)
result = df1.join(external_df, "id")
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'unknown right DF schema should not produce false positives');
    });

    test('matching types on join key produce no type issue', () => {
        const issues = validateSchema(makeCode('result = df1.join(df2, "id")'));
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_JOIN_001').length, 0,
            'same type on both sides should not be flagged');
    });

    test('incompatible types on join key are flagged as SCHEMA_JOIN_001', () => {
        // "name" is StringType in df1, "score" is DoubleType in df2 — but let us use a key
        // that exists in both with different types: we need a new setup
        const code = `
schema1 = StructType([StructField("key", StringType())])
schema2 = StructType([StructField("key", IntegerType())])
df1 = spark.read.schema(schema1).json(path)
df2 = spark.read.schema(schema2).json(path)
result = df1.join(df2, "key")
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_JOIN_001' && i.description.includes('"key"')),
            'incompatible join key types should be flagged');
    });

    test('both-numeric join key types are not flagged', () => {
        const code = `
schema1 = StructType([StructField("id", IntegerType())])
schema2 = StructType([StructField("id", LongType())])
df1 = spark.read.schema(schema1).json(path)
df2 = spark.read.schema(schema2).json(path)
result = df1.join(df2, "id")
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_JOIN_001').length, 0,
            'integer vs long is numeric-compatible and should not be flagged');
    });

    test('type mismatch on list join key is flagged', () => {
        const code = `
schema1 = StructType([StructField("id", IntegerType()), StructField("key", StringType())])
schema2 = StructType([StructField("id", IntegerType()), StructField("key", TimestampType())])
df1 = spark.read.schema(schema1).json(path)
df2 = spark.read.schema(schema2).json(path)
result = df1.join(df2, ["id", "key"])
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_JOIN_001' && i.description.includes('"key"')),
            'type mismatch in list join key should be flagged');
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_JOIN_001' && i.description.includes('"id"')).length, 0,
            'matching id type should not be flagged');
    });
});

suite('Edge Cases', () => {

    test('multi-line select still reports unknown columns', () => {
        const code = `
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df = spark.createDataFrame(data, schema)
df.select("id", "bad_col")
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('bad_col')),
            'unknown column in select should be flagged');
    });

    test('schema variable redefined later does not pollute earlier DataFrame', () => {
        const code = `
schema = StructType([StructField("a1", StringType()), StructField("a2", IntegerType())])
df1 = spark.read.schema(schema).json(path)
df1.select(col("a1"))

schema = StructType([StructField("name", StringType()), StructField("age", IntegerType())])
df2 = spark.read.schema(schema).json(path)
df2.select(col("name"))
`.trim();
        const issues = validateSchema(code);
        assert.strictEqual(issues.filter(i => i.id === 'SCHEMA_COL_001').length, 0,
            'valid columns for both DataFrames should not be flagged when schema is redefined');
    });

    test('schema variable redefined — second DataFrame gets second schema', () => {
        const code = `
schema = StructType([StructField("a1", StringType())])
df1 = spark.read.schema(schema).json(path)

schema = StructType([StructField("name", StringType())])
df2 = spark.read.schema(schema).json(path)
df2.select(col("a1"))
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_COL_001' && i.description.includes('"a1"')),
            'column from first schema should be flagged on second DataFrame');
    });

    test('backslash continuation lines each get their own squiggly on the correct line', () => {
        const code = [
            'schema = StructType([StructField("a1", StringType()), StructField("a2", IntegerType())])',
            'df = spark.createDataFrame(data, schema)',
            'df = df \\',
            '    .withColumn("x", col("typo1")) \\',
            '    .withColumn("y", col("typo2"))',
        ].join('\n');
        const issues = validateSchema(code);
        const col1 = issues.find(i => i.id === 'SCHEMA_COL_001' && i.description.includes('typo1'));
        const col2 = issues.find(i => i.id === 'SCHEMA_COL_001' && i.description.includes('typo2'));
        assert.ok(col1, 'typo1 should be flagged');
        assert.ok(col2, 'typo2 should be flagged');
        assert.strictEqual(col1!.line, 3, 'typo1 should be on line index 3 (4th line)');
        assert.strictEqual(col2!.line, 4, 'typo2 should be on line index 4 (5th line)');
    });

    test('levenshtein distance is computed correctly', () => {
        assert.strictEqual(levenshtein('', ''), 0);
        assert.strictEqual(levenshtein('abc', 'abc'), 0);
        assert.strictEqual(levenshtein('abc', 'ab'), 1);
        assert.strictEqual(levenshtein('kitten', 'sitting'), 3);
    });

    test('suggestColumns returns closest matches sorted by distance', () => {
        const fields = [
            { name: 'user_id', type: 'integer' as const },
            { name: 'username', type: 'string' as const },
            { name: 'email', type: 'string' as const },
        ];
        const suggestions = suggestColumns('user_idd', fields);
        assert.ok(suggestions.includes('user_id'), 'should suggest user_id');
        assert.ok(suggestions.length <= 3, 'should return at most 3 suggestions');
    });

    test('suggestColumns returns empty when no close match exists', () => {
        const fields = [{ name: 'alpha', type: 'string' as const }];
        const suggestions = suggestColumns('zzz', fields);
        assert.strictEqual(suggestions.length, 0, 'no close match should return empty array');
    });

    test('findMatchingParen handles nested parens correctly', () => {
        const code = 'foo(bar(baz()), qux())';
        const closeIdx = findMatchingParen(code, 3);
        assert.strictEqual(closeIdx, code.length - 1,
            'should find outer closing paren');
    });

    test('findMatchingParen handles quoted strings containing parens', () => {
        const code = 'f("(not a paren)")';
        const closeIdx = findMatchingParen(code, 1);
        assert.strictEqual(closeIdx, code.length - 1,
            'paren inside string should not affect depth tracking');
    });
});

// ── Union Column-Order Checks ──────────────────────────────────────────────────

suite('Union checks', () => {
    const SCHEMA_HEADER = `from pyspark.sql.types import StructType, StructField, StringType, IntegerType, LongType\n`;

    test('CODE_UNION_002: column order mismatch → CRITICAL', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.union(df2)
`.trim();
        const issues = validateSchema(code);
        const u = issues.find(i => i.id === 'CODE_UNION_002');
        assert.ok(u, 'should flag column order mismatch');
        assert.strictEqual(u!.severity, 'critical');
        assert.ok(u!.title.includes('column order mismatch'), `unexpected title: ${u!.title}`);
    });

    test('CODE_UNION_002: different column sets → CRITICAL', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("id", IntegerType()), StructField("email", StringType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.union(df2)
`.trim();
        const issues = validateSchema(code);
        const u = issues.find(i => i.id === 'CODE_UNION_002');
        assert.ok(u, 'should flag different column sets');
        assert.ok(u!.description.includes('allowMissingColumns'), 'fix should mention allowMissingColumns');
    });

    test('no CODE_UNION_002 when column order matches', () => {
        const code = SCHEMA_HEADER + `
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df1 = spark.createDataFrame(data1, schema=schema)
df2 = spark.createDataFrame(data2, schema=schema)
result = df1.union(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_002'), 'same schema order should not raise CODE_UNION_002');
    });

    test('no CODE_UNION_002 for unionByName regardless of order', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.unionByName(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_002'), 'unionByName should never raise CODE_UNION_002');
    });

    test('CODE_UNION_002 is suppressed by noqa', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.union(df2)  # noqa: catalystops
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_002'), 'noqa should suppress CODE_UNION_002');
    });

    test('CODE_UNION_002 is on the correct line', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.union(df2)
`.trim();
        const rawLines = code.split('\n');
        const issues = validateSchema(code);
        const u = issues.find(i => i.id === 'CODE_UNION_002');
        assert.ok(u, 'issue should exist');
        assert.strictEqual(rawLines[u!.line], 'result = df1.union(df2)');
    });

    test('CODE_UNION_002_MATCH: matching schemas emit SUGGESTION to prefer unionByName', () => {
        const code = SCHEMA_HEADER + `
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df1 = spark.createDataFrame(data1, schema=schema)
df2 = spark.createDataFrame(data2, schema=schema)
result = df1.union(df2)
`.trim();
        const issues = validateSchema(code);
        const u = issues.find(i => i.id === 'CODE_UNION_002_MATCH');
        assert.ok(u, 'should emit CODE_UNION_002_MATCH when schemas match');
        assert.strictEqual(u!.severity, 'suggestion', 'should be SUGGESTION severity');
    });

    test('CODE_UNION_002_MATCH: fix suggests unionByName', () => {
        const code = SCHEMA_HEADER + `
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df1 = spark.createDataFrame(data1, schema=schema)
df2 = spark.createDataFrame(data2, schema=schema)
result = df1.union(df2)
`.trim();
        const issues = validateSchema(code);
        const u = issues.find(i => i.id === 'CODE_UNION_002_MATCH');
        assert.ok(u?.fix?.code?.includes('unionByName'), 'fix should reference unionByName');
    });

    test('no CODE_UNION_002_MATCH when schemas mismatch (CRITICAL emitted instead)', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.union(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_002_MATCH'), 'mismatch should not emit _MATCH');
        assert.ok(issues.some(i => i.id === 'CODE_UNION_002'), 'mismatch should emit CODE_UNION_002 CRITICAL');
    });

    test('CODE_UNION_002_MATCH is suppressed by noqa', () => {
        const code = SCHEMA_HEADER + `
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df1 = spark.createDataFrame(data1, schema=schema)
df2 = spark.createDataFrame(data2, schema=schema)
result = df1.union(df2)  # noqa: catalystops
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_002_MATCH'), 'noqa should suppress _MATCH suggestion');
    });
});

// ── Intersect / Except / Subtract checks ─────────────────────────────────────

suite('Intersect / Except / Subtract checks', () => {
    const SCHEMA_HEADER = `from pyspark.sql.types import StructType, StructField, StringType, IntegerType\n`;

    test('CODE_INTERSECT_002: column order mismatch → CRITICAL', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.intersect(df2)
`.trim();
        const issues = validateSchema(code);
        const i = issues.find(x => x.id === 'CODE_INTERSECT_002');
        assert.ok(i, 'should flag column order mismatch for intersect()');
        assert.strictEqual(i!.severity, 'critical');
    });

    test('CODE_INTERSECT_002: intersectAll column order mismatch', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("a", IntegerType()), StructField("b", StringType())])
schema2 = StructType([StructField("b", StringType()), StructField("a", IntegerType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
result = df1.intersectAll(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(x => x.id === 'CODE_INTERSECT_002'), 'should flag intersectAll() too');
    });

    test('no CODE_INTERSECT_002 when column order matches', () => {
        const code = SCHEMA_HEADER + `
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df1 = spark.createDataFrame(data1, schema=schema)
df2 = spark.createDataFrame(data2, schema=schema)
result = df1.intersect(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(x => x.id === 'CODE_INTERSECT_002'), 'same order should not flag');
    });

    test('CODE_EXCEPT_002: except() column order mismatch → CRITICAL', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.except(df2)
`.trim();
        const issues = validateSchema(code);
        const e = issues.find(x => x.id === 'CODE_EXCEPT_002');
        assert.ok(e, 'should flag column order mismatch for except()');
        assert.strictEqual(e!.severity, 'critical');
    });

    test('CODE_EXCEPT_002: subtract() column order mismatch → CRITICAL', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.subtract(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(x => x.id === 'CODE_EXCEPT_002'), 'should flag subtract() column mismatch');
    });

    test('CODE_EXCEPT_002: exceptAll() column order mismatch', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame(data1, schema=schema1)
df2 = spark.createDataFrame(data2, schema=schema2)
result = df1.exceptAll(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(x => x.id === 'CODE_EXCEPT_002'), 'should flag exceptAll() too');
    });

    test('no CODE_INTERSECT_002 when intersect arg is an expression (user handled alignment)', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df_l = spark.createDataFrame([], schema=schema1)
df_r = spark.createDataFrame([], schema=schema2)
hits_ok = df_l.intersect(df_r.select(df_l.columns))
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(x => x.id === 'CODE_INTERSECT_002'), 'expression arg means user handled alignment — should not flag');
    });

    test('no CODE_INTERSECT_002 for intersect inside a comment', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df_l = spark.createDataFrame([], schema=schema1)
df_r = spark.createDataFrame([], schema=schema2)
# result = df_l.intersect(df_r)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(x => x.id === 'CODE_INTERSECT_002'), 'commented-out intersect should not be flagged');
    });

    test('no CODE_UNION_002 for union inside a comment', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("name", StringType()), StructField("id", IntegerType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
# result = df1.union(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(x => x.id === 'CODE_UNION_002'), 'commented-out union should not be flagged');
    });

    test('no CODE_INTERSECT_002 when intersect has completely different column sets', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("id", IntegerType()), StructField("email", StringType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
result = df1.intersect(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(x => x.id === 'CODE_INTERSECT_002'), 'different column sets should not trigger CODE_INTERSECT_002');
    });

    test('no CODE_EXCEPT_002 when except has completely different column sets', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("id", IntegerType()), StructField("email", StringType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
result = df1.except(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(x => x.id === 'CODE_EXCEPT_002'), 'different column sets should not trigger CODE_EXCEPT_002');
    });

    test('no CODE_EXCEPT_002 when subtract has completely different column sets', () => {
        const code = SCHEMA_HEADER + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("id", IntegerType()), StructField("email", StringType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
result = df1.subtract(df2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(x => x.id === 'CODE_EXCEPT_002'), 'different column sets should not trigger CODE_EXCEPT_002 for subtract');
    });
});

// ── UDF Return-Type Inference ─────────────────────────────────────────────────

import { extractUdfReturnTypes, analyzeWriteOps } from '../../vscode/analysis/schemaTracker';

suite('UDF return-type inference', () => {
    test('extracts return type from positional udf() arg', () => {
        const code = 'my_udf = udf(lambda x: x, IntegerType())';
        const types = extractUdfReturnTypes(code);
        assert.strictEqual(types.get('my_udf'), 'integer');
    });

    test('extracts return type from returnType= keyword arg', () => {
        const code = 'my_udf = udf(my_func, returnType=StringType())';
        const types = extractUdfReturnTypes(code);
        assert.strictEqual(types.get('my_udf'), 'string');
    });

    test('extracts return type from @udf(returnType=...) decorator', () => {
        const code = '@udf(returnType=DoubleType())\ndef my_fn(x):\n    return x * 2';
        const types = extractUdfReturnTypes(code);
        assert.strictEqual(types.get('my_fn'), 'double');
    });

    test('extracts return type from @udf(SomeType()) positional decorator', () => {
        const code = '@udf(LongType())\ndef compute(x):\n    return x';
        const types = extractUdfReturnTypes(code);
        assert.strictEqual(types.get('compute'), 'long');
    });

    test('returns empty map when no UDFs present', () => {
        const code = 'df = spark.read.parquet("s3://bucket")';
        const types = extractUdfReturnTypes(code);
        assert.strictEqual(types.size, 0);
    });

    test('UDF column type is tracked in schema and type mismatch is flagged', () => {
        const code = `from pyspark.sql.types import StructType, StructField, StringType, IntegerType
schema = StructType([StructField("value", StringType())])
df = spark.createDataFrame(data, schema=schema)
int_udf = udf(lambda x: len(x), IntegerType())
df2 = df.withColumn("int_col", int_udf(F.col("value")))
result = df2.select(F.upper("int_col"))
`;
        const issues = validateSchema(code);
        // F.upper requires a string column, but int_col is integer (from UDF) — should flag
        assert.ok(issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'should flag type mismatch on UDF column');
    });

    test('UDF with correct return type does not produce false-positive', () => {
        const code = `from pyspark.sql.types import StructType, StructField, StringType
schema = StructType([StructField("value", StringType())])
df = spark.createDataFrame(data, schema=schema)
str_udf = udf(lambda x: x.upper(), StringType())
df2 = df.withColumn("upper_col", str_udf(F.col("value")))
result = df2.select(F.upper("upper_col"))
`;
        const issues = validateSchema(code);
        // F.upper requires string, upper_col is string (from UDF) — should NOT flag
        assert.ok(!issues.some(i => i.id === 'SCHEMA_TYPE_001'), 'should not flag when UDF return type matches');
    });
});

// ── Write Operation Analysis ───────────────────────────────────────────────────

suite('analyzeWriteOps', () => {
    test('detects a simple batch write', () => {
        const code = `from pyspark.sql.types import StructType, StructField, StringType, IntegerType
schema = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
df = spark.createDataFrame(data, schema=schema)
df.write.mode("overwrite").parquet("output/")
`;
        const ops = analyzeWriteOps(code);
        assert.ok(ops.length > 0, 'should find at least one write operation');
        const op = ops[0];
        assert.strictEqual(op.varName, 'df');
        assert.strictEqual(op.isStreaming, false);
        assert.ok(op.columns.some(c => c.name === 'id'), 'should include id column');
        assert.ok(op.columns.some(c => c.name === 'name'), 'should include name column');
    });

    test('detects a streaming write', () => {
        const code = `from pyspark.sql.types import StructType, StructField, StringType
schema = StructType([StructField("msg", StringType())])
df = spark.readStream.schema(schema).json("s3://input/")
df.writeStream.format("delta").start()
`;
        const ops = analyzeWriteOps(code);
        const streamOp = ops.find(o => o.isStreaming);
        assert.ok(streamOp, 'should detect streaming write');
        assert.strictEqual(streamOp!.varName, 'df');
    });

    test('captures destination from .parquet(path)', () => {
        const code = `from pyspark.sql.types import StructType, StructField, StringType
schema = StructType([StructField("x", StringType())])
df = spark.createDataFrame(data, schema=schema)
df.write.parquet("s3://bucket/output")
`;
        const ops = analyzeWriteOps(code);
        assert.ok(ops.length > 0);
        assert.strictEqual(ops[0].destination, 's3://bucket/output');
    });

    test('returns empty columns when schema is unknown', () => {
        const code = 'df = spark.read.parquet("s3://bucket")\ndf.write.mode("overwrite").parquet("out/")';
        const ops = analyzeWriteOps(code);
        assert.ok(ops.length > 0, 'should still detect the write');
        assert.strictEqual(ops[0].columns.length, 0, 'columns should be empty when schema unknown');
    });

    test('does not detect Python file.write() as a Spark write', () => {
        const code = 'with open("out.txt", "w") as f:\n    f.write("hello")';
        const ops = analyzeWriteOps(code);
        assert.strictEqual(ops.length, 0, 'should not treat file.write() as Spark write');
    });
});

// ── Proactive schema-alignment check (SCHEMA_ALIGN_001) ───────────────────────

suite('Schema column alignment (SCHEMA_ALIGN_001)', () => {
    const HDR = `from pyspark.sql.types import StructType, StructField, StringType, IntegerType\n`;

    test('emits SCHEMA_ALIGN_001 when two DataFrames share the same columns in different order', () => {
        const code = HDR + `
schema1 = StructType([StructField("col1", StringType()), StructField("col2", IntegerType()), StructField("col3", StringType())])
schema2 = StructType([StructField("col1", StringType()), StructField("col3", StringType()), StructField("col2", IntegerType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
`.trim();
        const issues = validateSchema(code);
        const a = issues.find(i => i.id === 'SCHEMA_ALIGN_001');
        assert.ok(a, 'should emit SCHEMA_ALIGN_001');
        assert.strictEqual(a!.severity, 'warning', 'should be WARNING severity');
    });

    test('SCHEMA_ALIGN_001 is reported on the later DataFrame line', () => {
        const code = HDR + `
schema1 = StructType([StructField("col1", StringType()), StructField("col2", IntegerType()), StructField("col3", StringType())])
schema2 = StructType([StructField("col1", StringType()), StructField("col3", StringType()), StructField("col2", IntegerType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
`.trim();
        const rawLines = code.split('\n');
        const issues = validateSchema(code);
        const a = issues.find(i => i.id === 'SCHEMA_ALIGN_001');
        assert.ok(a, 'issue should exist');
        assert.ok(rawLines[a!.line].includes('df2'), 'should be reported on the df2 line');
    });

    test('fix suggests reordering to match the first DataFrame', () => {
        const code = HDR + `
schema1 = StructType([StructField("col1", StringType()), StructField("col2", IntegerType()), StructField("col3", StringType())])
schema2 = StructType([StructField("col1", StringType()), StructField("col3", StringType()), StructField("col2", IntegerType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
`.trim();
        const issues = validateSchema(code);
        const a = issues.find(i => i.id === 'SCHEMA_ALIGN_001');
        assert.ok(a?.fix?.code?.includes('"col1", "col2", "col3"'), 'fix should reorder to match df1');
    });

    test('no SCHEMA_ALIGN_001 when column orders are the same', () => {
        const code = HDR + `
schema = StructType([StructField("col1", StringType()), StructField("col2", IntegerType())])
df1 = spark.createDataFrame([], schema=schema)
df2 = spark.createDataFrame([], schema=schema)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'SCHEMA_ALIGN_001'), 'same order should not trigger SCHEMA_ALIGN_001');
    });

    test('no SCHEMA_ALIGN_001 when column sets differ (different columns, not just reordered)', () => {
        const code = HDR + `
schema1 = StructType([StructField("id", IntegerType()), StructField("name", StringType())])
schema2 = StructType([StructField("id", IntegerType()), StructField("email", StringType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'SCHEMA_ALIGN_001'), 'different column sets should not trigger SCHEMA_ALIGN_001');
    });

    test('SCHEMA_ALIGN_001 is suppressed by noqa on the later DataFrame line', () => {
        const code = HDR + `
schema1 = StructType([StructField("col1", StringType()), StructField("col2", IntegerType())])
schema2 = StructType([StructField("col2", IntegerType()), StructField("col1", StringType())])
df1 = spark.createDataFrame([], schema=schema1)
df2 = spark.createDataFrame([], schema=schema2)  # noqa: catalystops
`.trim();
        const issues = validateSchema(code);
        assert.ok(!issues.some(i => i.id === 'SCHEMA_ALIGN_001'), 'noqa should suppress SCHEMA_ALIGN_001');
    });

    test('works with multi-line StructType and createDataFrame (user scenario)', () => {
        const code = HDR + `
schema1 = StructType([
    StructField("col1", StringType()),
    StructField("col2", IntegerType()),
    StructField("col3", StringType()),
])
schema2 = StructType([
    StructField("col1", StringType()),
    StructField("col3", StringType()),
    StructField("col2", IntegerType()),
])
df1 = spark.createDataFrame(
    [("A", 10, "x"), ("B", 20, "y")],
    schema=schema1
)
df2 = spark.createDataFrame(
    [("A", 10, "x"), ("C", 30, "z")],
    schema=schema2
)
`.trim();
        const issues = validateSchema(code);
        assert.ok(issues.some(i => i.id === 'SCHEMA_ALIGN_001'), 'should detect column order mismatch in multi-line code');
    });
});

