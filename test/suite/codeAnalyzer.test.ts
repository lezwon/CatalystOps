/**
 * Tests for Code Analyzer
 */

import * as assert from 'assert';
import { analyzeCode } from '../../vscode/analysis/codeAnalyzer';

suite('Code Analyzer', () => {
    test('should detect UDF usage', () => {
        const code = 'my_udf = udf(lambda x: x * 2)';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_UDF_001'), 'should detect UDF');
    });

    test('should detect collect() usage', () => {
        const code = 'data = df.collect()';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_COLLECT_001'), 'should detect collect()');
        assert.strictEqual(issues.find(i => i.id === 'CODE_COLLECT_001')!.severity, 'critical');
    });

    test('should detect toPandas() usage', () => {
        const code = 'pdf = df.toPandas()';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_PANDAS_001'), 'should detect toPandas()');
    });

    test('should detect cross join', () => {
        const code = 'result = df1.crossJoin(df2)';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_CROSSJOIN_001'), 'should detect crossJoin');
        assert.strictEqual(issues.find(i => i.id === 'CODE_CROSSJOIN_001')!.severity, 'critical');
    });

    test('should detect SQL injection risk', () => {
        const code = 'spark.sql(f"SELECT * FROM {table}")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_SQL_INJECT_001'), 'should detect SQL injection');
    });

    test('should detect repartition(1)', () => {
        const code = 'df.repartition(1).write.parquet("out")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_REPARTITION_001'), 'should detect repartition(1)');
    });

    test('should detect coalesce(1)', () => {
        const code = 'df.coalesce(1)';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_COALESCE_001'), 'should detect coalesce(1)');
    });

    test('should detect schema inference', () => {
        const code = 'spark.read.option("inferSchema", "true").csv("data.csv")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_SCHEMA_001'), 'should detect schema inference');
    });

    test('should detect RDD conversion', () => {
        const code = 'rdd = df.rdd.map(lambda x: x)';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_RDD_001'), 'should detect RDD conversion');
    });

    test('should detect display() in production', () => {
        const code = 'display(df)';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DISPLAY_001'), 'should detect display()');
    });

    test('should detect dropDuplicates without subset', () => {
        const code = 'df.dropDuplicates()';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DROP_DUP_001'), 'should detect dropDuplicates()');
    });

    test('should return correct line numbers', () => {
        const code = 'x = 1\ny = 2\ndata = df.collect()\nz = 3';
        const issues = analyzeCode(code);
        const collectIssue = issues.find(i => i.id === 'CODE_COLLECT_001');
        assert.ok(collectIssue, 'should find collect issue');
        assert.strictEqual(collectIssue!.line, 2, 'should be on line 2 (0-indexed)');
    });

    test('should return empty for clean code', () => {
        const code = 'df = spark.read.parquet("path")\nresult = df.filter(col("x") > 1).select("x", "y")';
        const issues = analyzeCode(code);
        assert.strictEqual(issues.length, 0, 'should have no issues');
    });

    test('should detect multiple issues', () => {
        const code = `
data = df.collect()
df.show()
result = df1.crossJoin(df2)
spark.sql(f"SELECT * FROM {table}")
`;
        const issues = analyzeCode(code);
        assert.ok(issues.length >= 4, `should detect at least 4 issues, got ${issues.length}`);
    });

    test('should detect union() and suggest unionByName', () => {
        const code = 'result = df1.union(df2)';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_UNION_001'), 'should detect union()');
        assert.strictEqual(issues.find(i => i.id === 'CODE_UNION_001')!.severity, 'warning');
    });

    test('should not flag unionByName()', () => {
        const code = 'result = df1.unionByName(df2)';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_001'), 'should not flag unionByName()');
    });

    test('should not flag union() inside a comment', () => {
        const code = '# result = df1.union(df2)';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_001'), 'should skip comment lines');
    });

    test('should suppress union() with noqa', () => {
        const code = 'result = df1.union(df2)  # noqa: catalystops';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_UNION_001'), 'should respect noqa suppression');
    });

    test('should not flag intersect() (no generic warning — only schema-aware check fires)', () => {
        const code = 'result = df1.intersect(df2)';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_INTERSECT_001'), 'CODE_INTERSECT_001 removed');
    });

    test('should not flag except() (no generic warning — only schema-aware check fires)', () => {
        const code = 'result = df1.except(df2)';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_EXCEPT_001'), 'CODE_EXCEPT_001 removed');
    });
});
