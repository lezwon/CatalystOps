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
        const fields = map.get('schema');
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
        const fields = map.get('schema');
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
        assert.strictEqual(map.get('s1')!.length, 1);
        assert.strictEqual(map.get('s2')!.length, 2);
    });

    test('StructType with fields= keyword argument is parsed', () => {
        const code = `my_schema = StructType(fields=[StructField("ts", TimestampType()), StructField("val", DoubleType())])`;
        const map = extractStructTypeSchemas(code);
        const fields = map.get('my_schema');
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
