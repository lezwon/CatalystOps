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

    // ── Repeated source scan (opt-in via enableRepeatedScanDetection) ─────────
    // All tests in this section pass { enableRepeatedScanDetection: true } to opt in.
    // A separate test at the end verifies the feature is silent when disabled.

    test('CODE_REPRO_001: flags two direct actions on source DF without caching', () => {
        const code = [
            'big_df = spark.read.parquet("s3://bucket/data")',
            'big_df.count()',
            'big_df.show()',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'should flag repeated source scan');
        assert.strictEqual(issues.find(i => i.id === 'CODE_REPRO_001')!.severity, 'warning');
    });

    test('CODE_REPRO_001: does not flag when cached before second use', () => {
        const code = [
            'big_df = spark.read.parquet("s3://bucket/data")',
            'big_df.cache()',
            'big_df.count()',
            'big_df.show()',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'cached before second use — should not flag');
    });

    test('CODE_REPRO_001: does not flag single-use DataFrame', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df.write.parquet("out")',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'single use — no repeated scan');
    });

    test('CODE_REPRO_001: does not flag lazy self-reassignment chains', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df = df.filter(col("x") > 0)',
            'df = df.select("x", "y")',
            'df.write.parquet("out")',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'lazy self-reassignment chain — should not flag');
    });

    test('CODE_REPRO_001: flags spark.table() with two direct actions', () => {
        const code = [
            'orders = spark.table("catalog.orders")',
            'orders.count()',
            'orders.show()',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'spark.table used twice — should flag');
    });

    test('CODE_REPRO_001: does not flag when persist() is used instead of cache()', () => {
        const code = [
            'df = spark.read.csv("data.csv")',
            'df.persist()',
            'df.count()',
            'df.filter(col("x") > 0).count()',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'persist() before second use — should not flag');
    });

    // ── Alias and derived lineage ──────────────────────────────────────────────

    test('CODE_REPRO_001: flags alias used twice without caching source', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df2 = df',           // pure alias
            'df2.count()',        // scan #1 via alias
            'df2.show()',         // scan #2 via alias → FLAG df
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'alias used twice should flag the source');
    });

    test('CODE_REPRO_001: cache on alias prevents flag', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df2 = df',
            'df2.cache()',
            'df2.count()',
            'df2.show()',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'cache on alias should prevent flag');
    });

    test('CODE_REPRO_001: flags derived DataFrame with two actions on it', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'filtered = df.filter(col("x") > 0)',  // lazy derived — no scan yet
            'filtered.count()',                      // scan #1
            'filtered.show()',                       // scan #2 → FLAG df
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'two actions on derived DF should flag source');
    });

    test('CODE_REPRO_001: lazy derived assignment alone does not count as a scan', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'filtered = df.filter(col("x") > 0)',  // lazy — not a scan
            'filtered.count()',                      // only one scan total
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'single action via derived DF — should not flag');
    });

    test('CODE_REPRO_001: transitive chain — grandchild actions flag the root source', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df2 = df.filter(col("x") > 0)',   // derived from df
            'df3 = df2.select("x")',            // derived from df2 → from df
            'df3.count()',                       // scan #1
            'df3.show()',                        // scan #2 → FLAG df
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'transitive derived chain should flag source');
    });

    test('CODE_REPRO_001: mix of direct action and derived action counts together', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df.count()',                       // scan #1 (direct)
            'df2 = df.filter(col("x") > 0)',   // lazy derived
            'df2.show()',                        // scan #2 (via derived) → FLAG
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'direct + derived actions together should flag');
    });

    test('CODE_REPRO_001: action-in-chain (df2 = df.filter().count()) counts as scan not lazy', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'n = df.filter(col("x") > 0).count()',  // action in chain → scan #1, n not tracked
            'df.show()',                              // scan #2 → FLAG
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'action in chain should count as scan not lazy derive');
    });

    test('CODE_REPRO_001: tracked var as join argument is lazy, not a scan', () => {
        // b = other_df.join(a, ...) is lazy — a appears as argument, not chain base
        const code = [
            'a = spark.read.parquet("path")',
            'a = a.dropna()',
            'b = merged_df.join(a, on=["id"], how="inner")',  // lazy — NOT a scan of a
            'b.count()',                                        // scan #1
            'b.show()',                                         // scan #2 → FLAG a
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(issues.some(i => i.id === 'CODE_REPRO_001'), 'join argument var should be tracked — actions on result count as scans');
        // Scan count should be 2 (count + show), NOT 3 (join line wrongly counted)
        assert.strictEqual(issues.find(i => i.id === 'CODE_REPRO_001')!.title, '"a" scanned 2× — consider caching');
    });

    test('CODE_REPRO_001: if/else alias + join arg snippet without actions does not flag', () => {
        const code = [
            'a = spark.read.parquet("path")',
            'a = a.dropna()',
            'if cond is None:',
            '    b = a',
            'else:',
            '    b = merged_df.join(a, on=["aa", "bb"], how="inner")',
        ].join('\n');
        const issues = analyzeCode(code, { enableRepeatedScanDetection: true });
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'no actions in snippet — should not flag');
    });

    test('CODE_REPRO_001: disabled by default — no flag without opt-in', () => {
        const code = [
            'df = spark.read.parquet("path")',
            'df.count()',
            'df.show()',
        ].join('\n');
        // Default call with no options — feature disabled
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_REPRO_001'), 'feature is disabled by default');
    });
});
