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

    test('should flag withColumn() inside a for loop body', () => {
        const code = [
            'for col_name in columns:',
            '    df = df.withColumn(col_name, F.upper(F.col(col_name)))',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_WITHCOL_LOOP_001'), 'withColumn in loop body should be flagged');
    });

    test('should flag withColumn() deeper in a for loop body', () => {
        const code = [
            'for col_name in columns:',
            '    if col_name in subset:',
            '        df = df.withColumn(col_name, F.upper(F.col(col_name)))',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_WITHCOL_LOOP_001'), 'withColumn nested inside loop body should be flagged');
    });

    test('should NOT flag for loop when withColumn appears AFTER the loop (not inside it)', () => {
        const code = [
            'for item in items:',
            '    print(item)',
            '',
            'df = df.withColumn("x", F.col("x"))',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_WITHCOL_LOOP_001'), 'withColumn outside loop should not be flagged');
    });

    test('should NOT flag for loop with no withColumn at all', () => {
        const code = [
            'for item in items:',
            '    print(item)',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_WITHCOL_LOOP_001'), 'loop without withColumn should not be flagged');
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

    // ── AQE disabled ──────────────────────────────────────────────────────────

    test('CODE_AQE_001: flags spark.sql.adaptive.enabled = false (double quotes)', () => {
        const code = 'spark.conf.set("spark.sql.adaptive.enabled", "false")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_AQE_001'), 'should flag AQE disabled');
        assert.strictEqual(issues.find(i => i.id === 'CODE_AQE_001')!.severity, 'warning');
    });

    test('CODE_AQE_001: flags spark.sql.adaptive.enabled = False (Python bool)', () => {
        const code = "spark.conf.set('spark.sql.adaptive.enabled', False)";
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_AQE_001'), 'should flag Python bool False');
    });

    test('no CODE_AQE_001 when AQE is enabled', () => {
        const code = 'spark.conf.set("spark.sql.adaptive.enabled", "true")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_AQE_001'), 'enabling AQE should not be flagged');
    });

    // ── Window without partitionBy ────────────────────────────────────────────

    test('CODE_WINDOW_001: flags Window.orderBy() without partitionBy', () => {
        const code = 'w = Window.orderBy("timestamp")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_WINDOW_001'), 'global window should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_WINDOW_001')!.severity, 'warning');
    });

    test('CODE_WINDOW_001: flags inline Window.orderBy() in over()', () => {
        const code = 'df.withColumn("rank", F.rank().over(Window.orderBy("value")))';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_WINDOW_001'), 'inline global window should be flagged');
    });

    test('no CODE_WINDOW_001 when partitionBy is present on the same line', () => {
        const code = 'w = Window.partitionBy("user_id").orderBy("timestamp")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_WINDOW_001'), 'window with partitionBy should not be flagged');
    });

    test('no CODE_WINDOW_001 when partitionBy is on the preceding line (multi-line chain)', () => {
        const code = [
            'w = Window \\',
            '    .partitionBy("user_id") \\',
            '    .orderBy("timestamp")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_WINDOW_001'), 'multi-line window with partitionBy should not be flagged');
    });

    // ── Dynamic partition overwrite ───────────────────────────────────────────

    test('CODE_DYN_PART_001: flags overwrite + partitionBy without dynamic overwrite config', () => {
        const code = 'df.write.mode("overwrite").partitionBy("date").parquet("path")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DYN_PART_001'), 'static partition overwrite should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DYN_PART_001')!.severity, 'info');
    });

    test('no CODE_DYN_PART_001 when dynamic overwrite is configured', () => {
        const code = [
            'spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")',
            'df.write.mode("overwrite").partitionBy("date").parquet("path")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DYN_PART_001'), 'dynamic overwrite configured — should not be flagged');
    });

    test('no CODE_DYN_PART_001 when overwrite has no partitionBy', () => {
        const code = 'df.write.mode("overwrite").parquet("path")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DYN_PART_001'), 'overwrite without partitionBy needs no dynamic config');
    });

    // ── Repeated source scan ───────────────────────────────────────────────────

    test('CODE_REPRO_001: flags DataFrame used 2× without caching', () => {
        const code = [
            'big_df = spark.read.parquet("s3://bucket/data")',
            'count = big_df.count()',
            'result = big_df.filter(col("x") > 1)',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'should flag repeated source scan');
        assert.strictEqual(issues.find(i => i.id === 'CODE_REPRO_001')!.severity, 'warning');
    });

    test('CODE_REPRO_001: does not flag when cached before second use', () => {
        const code = [
            'big_df = spark.read.parquet("s3://bucket/data")',
            'big_df.cache()',
            'count = big_df.count()',
            'result = big_df.filter(col("x") > 1)',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'cached before second use — should not flag');
    });

    test('CODE_REPRO_001: does not flag single-use DataFrame', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'result = df.filter(col("x") > 1)',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'single use — no repeated scan');
    });

    test('CODE_REPRO_001: does not flag lazy transformation chains (same var reassignment)', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df = df.filter(col("x") > 0)',
            'df = df.select("x", "y")',
            'df.write.parquet("out")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'lazy transformation chain — should not flag');
    });

    test('CODE_REPRO_001: flags spark.table() used multiple times', () => {
        const code = [
            'orders = spark.table("catalog.orders")',
            'count = orders.count()',
            'top = orders.limit(10)',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'spark.table used twice — should flag');
    });

    test('CODE_REPRO_001: does not flag when persist() is used instead of cache()', () => {
        const code = [
            'df = spark.read.csv("data.csv")',
            'df.persist()',
            'c1 = df.count()',
            'c2 = df.filter(col("x") > 0).count()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'persist() before second use — should not flag');
    });
});
