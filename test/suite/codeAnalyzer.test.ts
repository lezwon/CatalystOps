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

    // ── Kafka auto-commit (CODE_KAFKA_001) ───────────────────────────────────

    test('CODE_KAFKA_001: flags kafka.enable.auto.commit = true (string)', () => {
        const code = '.option("kafka.enable.auto.commit", "true")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_KAFKA_001'), 'should flag kafka auto-commit enabled');
        assert.strictEqual(issues.find(i => i.id === 'CODE_KAFKA_001')!.severity, 'critical');
    });

    test('CODE_KAFKA_001: flags kafka.enable.auto.commit = True (Python bool)', () => {
        const code = ".option('kafka.enable.auto.commit', True)";
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_KAFKA_001'), 'should flag Python True');
    });

    test('no CODE_KAFKA_001 when auto-commit is false', () => {
        const code = '.option("kafka.enable.auto.commit", "false")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_KAFKA_001'), 'false should not be flagged');
    });

    // ── DBFS checkpoint (CODE_DBFS_CHECKPOINT_001) ───────────────────────────

    test('CODE_DBFS_CHECKPOINT_001: flags /dbfs/ checkpoint path', () => {
        const code = '.option("checkpointLocation", "/dbfs/checkpoints/stream")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DBFS_CHECKPOINT_001'), 'should flag /dbfs/ checkpoint');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DBFS_CHECKPOINT_001')!.severity, 'warning');
    });

    test('CODE_DBFS_CHECKPOINT_001: flags dbfs:/ checkpoint path', () => {
        const code = '.option("checkpointLocation", "dbfs:/checkpoints/stream")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DBFS_CHECKPOINT_001'), 'should flag dbfs:/ checkpoint');
    });

    test('no CODE_DBFS_CHECKPOINT_001 for Unity Catalog Volume path', () => {
        const code = '.option("checkpointLocation", "/Volumes/catalog/schema/checkpoints/stream")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DBFS_CHECKPOINT_001'), 'UC Volume path should not be flagged');
    });

    test('no CODE_DBFS_CHECKPOINT_001 for S3 path', () => {
        const code = '.option("checkpointLocation", "s3://bucket/checkpoints/stream")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DBFS_CHECKPOINT_001'), 'S3 path should not be flagged');
    });

    // ── Streaming trigger (CODE_STREAM_TRIGGER_001) ──────────────────────────

    test('CODE_STREAM_TRIGGER_001: flags writeStream.start() without trigger', () => {
        const code = [
            'df.writeStream',
            '    .format("delta")',
            '    .option("checkpointLocation", "/Volumes/cp")',
            '    .start()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_STREAM_TRIGGER_001'), 'missing trigger should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_STREAM_TRIGGER_001')!.severity, 'warning');
    });

    test('no CODE_STREAM_TRIGGER_001 when processingTime trigger is set', () => {
        const code = [
            'df.writeStream',
            '    .trigger(processingTime="5 minutes")',
            '    .format("delta")',
            '    .start()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_TRIGGER_001'), 'trigger present — should not flag');
    });

    test('no CODE_STREAM_TRIGGER_001 when availableNow trigger is set', () => {
        const code = [
            'df.writeStream',
            '    .trigger(availableNow=True)',
            '    .format("delta")',
            '    .start()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_TRIGGER_001'), 'availableNow trigger — should not flag');
    });

    test('no CODE_STREAM_TRIGGER_001 when writeStream has no .start() (incomplete chain)', () => {
        const code = 'query = df.writeStream.format("delta")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_TRIGGER_001'), 'no .start() — should not flag');
    });

    // ── Streaming groupBy without watermark (CODE_STREAM_WATERMARK_001) ──────

    test('CODE_STREAM_WATERMARK_001: flags groupBy on streaming DF without withWatermark', () => {
        const code = [
            'stream = spark.readStream.format("delta").table("events")',
            'result = stream.groupBy("user_id").count()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_STREAM_WATERMARK_001'), 'missing watermark should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_STREAM_WATERMARK_001')!.severity, 'warning');
    });

    test('no CODE_STREAM_WATERMARK_001 when withWatermark precedes groupBy', () => {
        const code = [
            'stream = spark.readStream.format("delta").table("events")',
            'result = stream.withWatermark("event_time", "1 hour").groupBy("user_id").count()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_WATERMARK_001'), 'watermark present — should not flag');
    });

    test('no CODE_STREAM_WATERMARK_001 when file has no readStream', () => {
        const code = 'df.groupBy("user_id").count()';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_WATERMARK_001'), 'no readStream — batch groupBy should not flag');
    });

    // ── DROP TABLE + CREATE TABLE (CODE_DROP_CREATE_001) ─────────────────────

    test('CODE_DROP_CREATE_001: flags DROP TABLE followed by CREATE TABLE', () => {
        const code = [
            'spark.sql("DROP TABLE IF EXISTS my_table")',
            'spark.sql("CREATE TABLE my_table (id BIGINT) USING DELTA")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DROP_CREATE_001'), 'should flag DROP + CREATE pattern');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DROP_CREATE_001')!.severity, 'warning');
    });

    test('CODE_DROP_CREATE_001: flags DROP TABLE + CREATE TABLE in same SQL block', () => {
        const code = [
            'spark.sql("""',
            '    DROP TABLE IF EXISTS foo;',
            '    CREATE TABLE foo (id BIGINT) USING DELTA',
            '""")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DROP_CREATE_001'), 'should flag in multi-line SQL block');
    });

    test('no CODE_DROP_CREATE_001 for DROP TABLE without CREATE TABLE', () => {
        const code = 'spark.sql("DROP TABLE IF EXISTS my_table")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DROP_CREATE_001'), 'DROP alone should not flag');
    });

    test('no CODE_DROP_CREATE_001 for standalone CREATE OR REPLACE TABLE', () => {
        const code = 'spark.sql("CREATE OR REPLACE TABLE my_table (id BIGINT) USING DELTA")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DROP_CREATE_001'), 'CREATE OR REPLACE alone should not flag');
    });

    // ── Z-ORDER instead of Liquid Clustering (CODE_ZORDER_001) ───────────────

    test('CODE_ZORDER_001: flags ZORDER BY in OPTIMIZE statement', () => {
        const code = 'spark.sql("OPTIMIZE my_table ZORDER BY (event_date, user_id)")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_ZORDER_001'), 'should flag ZORDER BY');
        assert.strictEqual(issues.find(i => i.id === 'CODE_ZORDER_001')!.severity, 'info');
    });

    test('CODE_ZORDER_001: flags Z-ORDER BY variant', () => {
        const code = 'spark.sql("OPTIMIZE my_table Z-ORDER BY (col)")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_ZORDER_001'), 'should flag Z-ORDER BY');
    });

    test('no CODE_ZORDER_001 for CLUSTER BY (Liquid Clustering)', () => {
        const code = 'spark.sql("CREATE TABLE t USING DELTA CLUSTER BY (event_date)")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_ZORDER_001'), 'CLUSTER BY should not flag');
    });

    // ── Dynamic allocation on streaming (CODE_DYN_ALLOC_STREAM_001) ──────────

    test('CODE_DYN_ALLOC_STREAM_001: flags dynamic allocation enabled (string true)', () => {
        const code = 'spark.conf.set("spark.dynamicAllocation.enabled", "true")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DYN_ALLOC_STREAM_001'), 'should flag dynamic allocation');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DYN_ALLOC_STREAM_001')!.severity, 'warning');
    });

    test('CODE_DYN_ALLOC_STREAM_001: flags dynamic allocation enabled (Python True)', () => {
        const code = "spark.conf.set('spark.dynamicAllocation.enabled', True)";
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DYN_ALLOC_STREAM_001'), 'should flag Python True');
    });

    test('no CODE_DYN_ALLOC_STREAM_001 when set to false', () => {
        const code = 'spark.conf.set("spark.dynamicAllocation.enabled", "false")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DYN_ALLOC_STREAM_001'), 'false should not be flagged');
    });

    // ── Missing queryName on streaming (CODE_STREAM_QUERYNAME_001) ───────────

    test('CODE_STREAM_QUERYNAME_001: flags writeStream.start() without queryName', () => {
        const code = [
            'df.writeStream',
            '    .format("delta")',
            '    .option("checkpointLocation", "/Volumes/cp")',
            '    .start()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_STREAM_QUERYNAME_001'), 'missing queryName should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_STREAM_QUERYNAME_001')!.severity, 'info');
    });

    test('no CODE_STREAM_QUERYNAME_001 when queryName is set', () => {
        const code = [
            'df.writeStream',
            '    .option("queryName", "events_to_silver")',
            '    .format("delta")',
            '    .start()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_QUERYNAME_001'), 'queryName present — should not flag');
    });

    // ── FLOAT/DOUBLE for financial columns (CODE_FLOAT_FINANCIAL_001) ─────────

    test('CODE_FLOAT_FINANCIAL_001: flags FloatType for price column', () => {
        const code = 'StructField("price", FloatType())';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_FLOAT_FINANCIAL_001'), 'FloatType for price should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_FLOAT_FINANCIAL_001')!.severity, 'warning');
    });

    test('CODE_FLOAT_FINANCIAL_001: flags DoubleType for amount column', () => {
        const code = 'StructField("amount", DoubleType())';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_FLOAT_FINANCIAL_001'), 'DoubleType for amount should be flagged');
    });

    test('no CODE_FLOAT_FINANCIAL_001 for non-financial FloatType column', () => {
        const code = 'StructField("latitude", FloatType())';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_FLOAT_FINANCIAL_001'), 'non-financial float should not flag');
    });

    test('no CODE_FLOAT_FINANCIAL_001 for DecimalType on financial column', () => {
        const code = 'StructField("price", DecimalType(18, 2))';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_FLOAT_FINANCIAL_001'), 'DecimalType should not flag');
    });

    // ── OPTIMIZE after MERGE in foreachBatch (CODE_MERGE_OPTIMIZE_001) ────────

    test('CODE_MERGE_OPTIMIZE_001: flags MERGE INTO followed by OPTIMIZE', () => {
        const code = [
            'spark.sql(f"MERGE INTO {target} USING source ON ...")',
            'spark.sql(f"OPTIMIZE {target}")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_MERGE_OPTIMIZE_001'), 'MERGE + OPTIMIZE should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_MERGE_OPTIMIZE_001')!.severity, 'warning');
    });

    test('no CODE_MERGE_OPTIMIZE_001 for MERGE without OPTIMIZE nearby', () => {
        const code = 'spark.sql("MERGE INTO my_table USING source ON ...")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_MERGE_OPTIMIZE_001'), 'MERGE alone should not flag');
    });

    // ── Inner join in streaming context (CODE_STREAM_JOIN_001) ───────────────

    test('CODE_STREAM_JOIN_001: flags default inner join in streaming file', () => {
        const code = [
            'stream = spark.readStream.format("delta").table("events")',
            'enriched = stream.join(dim_df, "customer_id")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_STREAM_JOIN_001'), 'inner join in streaming should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_STREAM_JOIN_001')!.severity, 'warning');
    });

    test('no CODE_STREAM_JOIN_001 when left join is specified', () => {
        const code = [
            'stream = spark.readStream.format("delta").table("events")',
            'enriched = stream.join(dim_df, "customer_id", how="left")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_JOIN_001'), 'left join should not flag');
    });

    test('no CODE_STREAM_JOIN_001 in batch file without readStream', () => {
        const code = 'result = df1.join(df2, "id")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_STREAM_JOIN_001'), 'batch join without readStream should not flag');
    });

    // ── Missing ANALYZE TABLE after overwrite (CODE_ANALYZE_001) ─────────────

    test('CODE_ANALYZE_001: flags mode(overwrite).saveAsTable without ANALYZE', () => {
        const code = 'df.write.mode("overwrite").saveAsTable("my_catalog.my_table")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_ANALYZE_001'), 'overwrite without ANALYZE should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_ANALYZE_001')!.severity, 'info');
    });

    test('no CODE_ANALYZE_001 when ANALYZE TABLE follows overwrite', () => {
        const code = [
            'df.write.mode("overwrite").saveAsTable("my_table")',
            'spark.sql("ANALYZE TABLE my_table COMPUTE STATISTICS FOR ALL COLUMNS")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_ANALYZE_001'), 'ANALYZE present — should not flag');
    });

    test('CODE_ANALYZE_001: flags INSERT OVERWRITE without ANALYZE TABLE', () => {
        const code = 'spark.sql("INSERT OVERWRITE my_table SELECT * FROM source")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_ANALYZE_001'), 'INSERT OVERWRITE without ANALYZE should flag');
    });

    test('CODE_ANALYZE_001: flags mode(overwrite).save() without ANALYZE', () => {
        const code = 'df.write.format("delta").mode("overwrite").save("/path/to/table")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_ANALYZE_001'), 'overwrite .save() without ANALYZE should flag');
    });

    // ── MERGE without Deletion Vectors (CODE_MERGE_DV_001) ───────────────────

    test('CODE_MERGE_DV_001: flags MERGE INTO without enableDeletionVectors config', () => {
        const code = 'spark.sql("MERGE INTO my_table USING source ON my_table.id = source.id WHEN MATCHED THEN UPDATE SET *")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_MERGE_DV_001'), 'MERGE without DV should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_MERGE_DV_001')!.severity, 'info');
    });

    test('CODE_MERGE_DV_001: flags DeltaTable .merge() API without enableDeletionVectors', () => {
        const code = [
            'from delta.tables import DeltaTable',
            'deltaTable = DeltaTable.forName(spark, "my_table")',
            'deltaTable.alias("t").merge(source.alias("s"), "t.id = s.id").whenMatchedUpdateAll().execute()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_MERGE_DV_001'), 'DeltaTable .merge() without DV should flag');
    });

    test('no CODE_MERGE_DV_001 when enableDeletionVectors is referenced', () => {
        const code = [
            'spark.sql("ALTER TABLE t SET TBLPROPERTIES (\'delta.enableDeletionVectors\' = \'true\')")',
            'spark.sql("MERGE INTO t USING src ON t.id = src.id WHEN MATCHED THEN UPDATE SET *")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_MERGE_DV_001'), 'DV configured — should not flag');
    });

    // ── MERGE without Row-Level Concurrency (CODE_MERGE_RLC_001) ─────────────

    test('CODE_MERGE_RLC_001: flags MERGE INTO without enableRowLevelConcurrency config', () => {
        const code = 'spark.sql("MERGE INTO my_table USING source ON my_table.id = source.id WHEN MATCHED THEN UPDATE SET *")';
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_MERGE_RLC_001'), 'MERGE without RLC should be flagged');
        assert.strictEqual(issues.find(i => i.id === 'CODE_MERGE_RLC_001')!.severity, 'info');
    });

    test('CODE_MERGE_RLC_001: flags DeltaTable .merge() API without enableRowLevelConcurrency', () => {
        const code = [
            'from delta.tables import DeltaTable',
            'deltaTable = DeltaTable.forName(spark, "my_table")',
            'deltaTable.alias("t").merge(source.alias("s"), "t.id = s.id").whenMatchedUpdateAll().execute()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_MERGE_RLC_001'), 'DeltaTable .merge() without RLC should flag');
    });

    test('no CODE_MERGE_RLC_001 when enableRowLevelConcurrency is referenced', () => {
        const code = [
            'spark.sql("ALTER TABLE t SET TBLPROPERTIES (\'delta.enableRowLevelConcurrency\' = \'true\')")',
            'spark.sql("MERGE INTO t USING src ON t.id = src.id WHEN MATCHED THEN UPDATE SET *")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_MERGE_RLC_001'), 'RLC configured — should not flag');
    });

    // ── Auto Loader without maxBytesPerTrigger (CODE_AUTOLOADER_RATE_001) ─────

    test('CODE_AUTOLOADER_RATE_001: flags Auto Loader stream without maxBytesPerTrigger', () => {
        const code = [
            'stream = (spark.readStream',
            '    .format("cloudFiles")',
            '    .option("cloudFiles.format", "json")',
            '    .load(path))',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_AUTOLOADER_RATE_001'), 'missing maxBytesPerTrigger should flag');
        assert.strictEqual(issues.find(i => i.id === 'CODE_AUTOLOADER_RATE_001')!.severity, 'info');
    });

    test('CODE_AUTOLOADER_RATE_001: flags .format("cloudFiles") without maxBytesPerTrigger', () => {
        const code = [
            'stream = (spark.readStream',
            '    .format("cloudFiles")',
            '    .load(path))',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_AUTOLOADER_RATE_001'), '.format("cloudFiles") without maxBytesPerTrigger should flag');
    });

    test('no CODE_AUTOLOADER_RATE_001 when maxBytesPerTrigger is set', () => {
        const code = [
            'stream = (spark.readStream',
            '    .format("cloudFiles")',
            '    .option("cloudFiles.format", "json")',
            '    .option("maxBytesPerTrigger", "100m")',
            '    .load(path))',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_AUTOLOADER_RATE_001'), 'maxBytesPerTrigger set — should not flag');
    });

    // ── RocksDB not configured for stateful streaming (CODE_ROCKSDB_001) ──────

    test('CODE_ROCKSDB_001: flags stateful streaming without RocksDB config', () => {
        const code = [
            'stream = spark.readStream.format("delta").table("events")',
            'result = stream.withWatermark("event_time", "1 hour").groupBy("user_id").count()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_ROCKSDB_001'), 'stateful streaming without RocksDB should flag');
        assert.strictEqual(issues.find(i => i.id === 'CODE_ROCKSDB_001')!.severity, 'info');
    });

    test('no CODE_ROCKSDB_001 when RocksDB state store is configured', () => {
        const code = [
            'spark.conf.set("spark.sql.streaming.stateStore.providerClass", "com.databricks.sql.streaming.state.RocksDBStateProvider")',
            'stream = spark.readStream.format("delta").table("events")',
            'result = stream.withWatermark("event_time", "1 hour").groupBy("user_id").count()',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_ROCKSDB_001'), 'RocksDB configured — should not flag');
    });

    test('no CODE_ROCKSDB_001 in batch file without readStream', () => {
        const code = 'result = df.groupBy("user_id").count()';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_ROCKSDB_001'), 'batch groupBy without readStream should not flag');
    });

    // ── DLT: PARTITION BY instead of CLUSTER BY (CODE_DLT_PARTITION_001) ─────

    test('CODE_DLT_PARTITION_001: flags PARTITION BY in a DLT file', () => {
        const code = [
            '@dlt.table()',
            'def my_table():',
            '    return spark.sql("CREATE OR REPLACE STREAMING LIVE TABLE t PARTITION BY (event_date) AS SELECT id FROM src")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DLT_PARTITION_001'), 'PARTITION BY in DLT file should flag');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DLT_PARTITION_001')!.severity, 'warning');
    });

    test('CODE_DLT_PARTITION_001: flags Python partition_cols= in a DLT file', () => {
        const code = [
            '@dlt.table(partition_cols=["event_date"])',
            'def my_table():',
            '    return spark.sql("SELECT * FROM LIVE.src")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DLT_PARTITION_001'), 'partition_cols= in DLT file should flag');
    });

    test('CODE_DLT_PARTITION_001: flags PARTITIONED BY in a DLT SQL file', () => {
        const code = [
            'CREATE OR REPLACE LIVE TABLE my_table',
            'PARTITIONED BY (event_date)',
            'AS SELECT id, event_date FROM LIVE.src',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DLT_PARTITION_001'), 'PARTITIONED BY in DLT SQL file should flag');
    });

    test('no CODE_DLT_PARTITION_001 in a non-DLT file', () => {
        const code = 'df.write.mode("overwrite").partitionBy("event_date").parquet("path")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DLT_PARTITION_001'), 'PARTITION BY outside DLT should not flag this check');
    });

    test('no CODE_DLT_PARTITION_001 when CLUSTER BY is used in DLT file', () => {
        const code = [
            '@dlt.table(cluster_by=["event_date"])',
            'def my_table():',
            '    return spark.sql("SELECT * FROM LIVE.src")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DLT_PARTITION_001'), 'CLUSTER BY in DLT should not flag');
    });

    // ── DLT: SELECT * in pipeline (CODE_DLT_SELECT_STAR_001) ─────────────────

    test('CODE_DLT_SELECT_STAR_001: flags SELECT * in a DLT SQL pipeline', () => {
        const code = [
            '@dlt.table()',
            'def my_view():',
            '    return spark.sql("SELECT * FROM LIVE.source_table")',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DLT_SELECT_STAR_001'), 'SELECT * in DLT file should flag');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DLT_SELECT_STAR_001')!.severity, 'info');
    });

    test('no CODE_DLT_SELECT_STAR_001 in non-DLT file', () => {
        const code = 'df.select("*")';
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DLT_SELECT_STAR_001'), 'SELECT * outside DLT should not flag this check');
    });

    // ── DLT: read_files() without schemaHints (CODE_DLT_SCHEMA_HINTS_001) ────

    test('CODE_DLT_SCHEMA_HINTS_001: flags read_files() without schemaHints in DLT file', () => {
        const code = [
            '@dlt.table()',
            'def bronze():',
            '    return spark.sql(\'SELECT * FROM read_files("s3://bucket/events/", format => "json")\')',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DLT_SCHEMA_HINTS_001'), 'read_files without schemaHints should flag');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DLT_SCHEMA_HINTS_001')!.severity, 'warning');
    });

    test('no CODE_DLT_SCHEMA_HINTS_001 when schemaHints is provided', () => {
        const code = [
            '@dlt.table()',
            'def bronze():',
            '    return spark.sql(\'SELECT * FROM read_files("s3://bucket/events/", format => "json", schemaHints => "id BIGINT")\')',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DLT_SCHEMA_HINTS_001'), 'schemaHints present — should not flag');
    });

    // ── DLT: APPLY AS DELETE WHEN after SEQUENCE BY (CODE_DLT_CDC_ORDER_001) ──

    test('CODE_DLT_CDC_ORDER_001: flags APPLY AS DELETE WHEN after SEQUENCE BY', () => {
        const code = [
            'APPLY CHANGES INTO LIVE.target',
            'FROM STREAM(LIVE.source)',
            'KEYS (id)',
            'SEQUENCE BY updated_at',
            'APPLY AS DELETE WHEN operation = "DELETE"',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DLT_CDC_ORDER_001'), 'DELETE WHEN after SEQUENCE BY should flag');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DLT_CDC_ORDER_001')!.severity, 'critical');
    });

    test('no CODE_DLT_CDC_ORDER_001 when APPLY AS DELETE WHEN is before SEQUENCE BY', () => {
        const code = [
            'APPLY CHANGES INTO LIVE.target',
            'FROM STREAM(LIVE.source)',
            'KEYS (id)',
            'APPLY AS DELETE WHEN operation = "DELETE"',
            'SEQUENCE BY updated_at',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DLT_CDC_ORDER_001'), 'correct order — should not flag');
    });

    // ── DLT: CLUSTER BY AUTO in production (CODE_DLT_CLUSTER_AUTO_001) ───────

    test('CODE_DLT_CLUSTER_AUTO_001: flags CLUSTER BY AUTO in DLT file', () => {
        const code = [
            'CREATE OR REPLACE STREAMING LIVE TABLE my_table',
            'CLUSTER BY AUTO',
            'AS SELECT * FROM STREAM(LIVE.source)',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(issues.some(i => i.id === 'CODE_DLT_CLUSTER_AUTO_001'), 'CLUSTER BY AUTO in DLT should flag');
        assert.strictEqual(issues.find(i => i.id === 'CODE_DLT_CLUSTER_AUTO_001')!.severity, 'info');
    });

    test('no CODE_DLT_CLUSTER_AUTO_001 for explicit CLUSTER BY keys in DLT file', () => {
        const code = [
            'CREATE OR REPLACE STREAMING LIVE TABLE my_table',
            'CLUSTER BY (event_date, user_id)',
            'AS SELECT * FROM STREAM(LIVE.source)',
        ].join('\n');
        const issues = analyzeCode(code);
        assert.ok(!issues.some(i => i.id === 'CODE_DLT_CLUSTER_AUTO_001'), 'explicit cluster keys should not flag');
    });

    test('no DLT checks fire in non-DLT file', () => {
        const code = [
            'df = spark.read.parquet("s3://bucket/data")',
            'df.write.mode("overwrite").saveAsTable("my_table")',
        ].join('\n');
        const issues = analyzeCode(code);
        const dltIds = ['CODE_DLT_PARTITION_001', 'CODE_DLT_SELECT_STAR_001', 'CODE_DLT_SCHEMA_HINTS_001', 'CODE_DLT_CDC_ORDER_001', 'CODE_DLT_CLUSTER_AUTO_001'];
        const dltIssues = issues.filter(i => dltIds.includes(i.id));
        assert.strictEqual(dltIssues.length, 0, 'no DLT checks should fire in a non-DLT file');
    });
});
