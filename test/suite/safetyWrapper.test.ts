/**
 * Tests for Safety Wrapper
 */

import * as assert from 'assert';
import { neutralizeCode } from '../../vscode/analysis/safetyWrapper';

suite('Safety Wrapper', () => {

    // --- Basic action replacements (now use _catalystops_capture) ---

    test('should neutralize .collect()', () => {
        const result = neutralizeCode('result = df.collect()');
        assert.ok(!result.includes('.collect()'), 'collect() should be replaced');
        assert.ok(result.includes('_catalystops_capture(df)'), 'should call _catalystops_capture');
    });

    test('should neutralize .show()', () => {
        const result = neutralizeCode('df.show()');
        assert.ok(!result.includes('.show()'), 'show() should be replaced');
        assert.ok(result.includes('_catalystops_capture(df)'), 'should call _catalystops_capture');
    });

    test('should neutralize .toPandas()', () => {
        const result = neutralizeCode('pdf = df.toPandas()');
        assert.ok(!result.includes('.toPandas()'), 'toPandas() should be replaced');
        assert.ok(result.includes('_catalystops_capture(df)'), 'should call _catalystops_capture');
    });

    test('should neutralize display()', () => {
        const result = neutralizeCode('display(df)');
        assert.ok(!result.includes('display(df)'), 'display() should be replaced');
        assert.ok(result.includes('_catalystops_capture(df)'), 'should call _catalystops_capture');
    });

    test('should neutralize .count()', () => {
        const result = neutralizeCode('n = df.count()');
        assert.ok(!result.includes('.count()'), 'count() should be replaced');
        assert.ok(result.includes('_catalystops_capture(df)'), 'should call _catalystops_capture');
    });

    // --- .write ---

    test('should neutralize .write chain on one line', () => {
        const result = neutralizeCode('df.write.mode("overwrite").saveAsTable("my_table")');
        assert.ok(!result.includes('.saveAsTable'), '.saveAsTable should be dropped');
        assert.ok(result.includes('_catalystops_capture(df)'), 'should call _catalystops_capture');
    });

    // --- writeStream ---

    test('should neutralize writeStream one-liner', () => {
        const result = neutralizeCode('df.writeStream.outputMode("append").start()');
        assert.ok(!result.includes('.start()'), 'start() should not be in output');
        assert.ok(result.includes('_catalystops_capture(df)'), 'should call _catalystops_capture');
    });

    test('should neutralize writeStream and drop chained continuations', () => {
        const code = [
            'df.writeStream',
            '  .outputMode("append")',
            '  .format("delta")',
            '  .start()',
            'x = 1',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(result.includes('_catalystops_capture(df)'), 'should capture df');
        assert.ok(!result.includes('.outputMode'), 'continuation lines should be dropped');
        assert.ok(!result.includes('.start()'), 'start() should be dropped');
        assert.ok(result.includes('x = 1'), 'unrelated code after chain should be kept');
    });

    test('should neutralize writeStream with foreachBatch lambda (multi-line chain)', () => {
        const code = [
            'query = (',
            '    df.writeStream',
            '    .foreachBatch(',
            '        lambda batch_df, batch_id: batch_df.write.saveAsTable("t")',
            '    )',
            '    .start()',
            ')',
            'x = 2',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(result.includes('_catalystops_capture(df)'), 'should capture df');
        assert.ok(!result.includes('.foreachBatch'), 'foreachBatch should be dropped');
        assert.ok(!result.includes('.start()'), 'start() should be dropped');
        assert.ok(result.includes('x = 2'), 'code after chain should be kept');
    });

    // --- awaitTermination ---

    test('should comment out awaitTermination()', () => {
        const result = neutralizeCode('query.awaitTermination()');
        // The line is preserved as a comment — every line that contains awaitTermination must start with #
        const lines = result.split('\n').filter(l => l.includes('awaitTermination'));
        assert.ok(lines.length > 0, 'awaitTermination line should be present (as a comment)');
        assert.ok(lines.every(l => l.trimStart().startsWith('#')), 'awaitTermination should be commented out');
        assert.ok(result.includes('# [CatalystOps: neutralized]'), 'should carry the neutralized marker');
    });

    // --- Code after dangerous line is preserved ---

    test('should keep code after .count() — chain mode stops at first non-dot line', () => {
        const code = [
            'n = df.count()',
            'result = df.filter("x > 0")',
            'df2 = spark.read.parquet("path")',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(result.includes('_catalystops_capture(df)'), 'count should be replaced');
        assert.ok(result.includes('result = df.filter("x > 0")'), 'filter line should be kept');
        assert.ok(result.includes('df2 = spark.read.parquet("path")'), 'subsequent lines should be kept');
    });

    test('should not be confused by comment with unbalanced paren after .count()', () => {
        const code = [
            'n = df.count()',
            '# This comment has an unmatched paren (for example',
            'df2 = df.filter("x > 0")',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(result.includes('_catalystops_capture(df)'), 'count should be replaced');
        assert.ok(result.includes('df2 = df.filter("x > 0")'), 'code after comment should not be dropped');
    });

    // --- Non-action code is unchanged ---

    test('should leave non-action code unchanged', () => {
        const code = 'df = spark.read.parquet("path")\ndf2 = df.filter(col("x") > 1)';
        const result = neutralizeCode(code);
        assert.strictEqual(result, code, 'non-action code should be unchanged');
    });

    // --- display() with argument ---

    test('should neutralize display() with chained expression', () => {
        const result = neutralizeCode('display(df.groupBy("a").count())');
        assert.ok(!result.includes('display('), 'display() should be replaced');
        assert.ok(result.includes('_catalystops_capture('), 'should call _catalystops_capture');
    });

    // --- Dict value positions ---

    test('should neutralize .count() inside a dict value', () => {
        const code = [
            'metrics = {',
            '    "a": df[df.eventtype == "view"].et.count(),',
            '    "b": df[df.eventtype == "cart"].et.count(),',
            '}',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(!result.includes('.count()'), '.count() should be replaced');
        assert.ok(result.includes('"a": _catalystops_capture('), 'dict key "a" should be preserved');
        assert.ok(result.includes('"b": _catalystops_capture('), 'dict key "b" should be preserved');
        assert.ok(result.includes('}'), 'closing brace should be kept');
    });

    test('should preserve trailing comma on dict entry replacement', () => {
        const result = neutralizeCode('    "a": df.count(),');
        assert.ok(result.includes('"a": _catalystops_capture(df),'), 'trailing comma should be preserved');
    });

    test('should neutralize .collect() inside a dict value', () => {
        const result = neutralizeCode('    view: df.filter("x > 0").collect(),');
        assert.ok(!result.includes('.collect()'), 'collect() should be replaced');
        assert.ok(result.includes('view: _catalystops_capture('), 'bareword dict key should be preserved');
        assert.ok(result.includes(','), 'trailing comma should be preserved');
    });

    // --- Dangerous call embedded as argument to another function ---

    test('should splice capture inline when .count() is inside print()', () => {
        const line = 'print("this is ", hash["key"] + "the end ", id_, " is ", len(store), df.count())';
        const result = neutralizeCode(line);
        assert.ok(!result.includes('.count()'), '.count() should not execute');
        assert.ok(result.includes('_catalystops_capture(df)'), 'df should be captured');
        assert.ok(result.startsWith('print('), 'outer print() call should be preserved');
    });

    test('should splice capture inline when .collect() is an arg to an outer call', () => {
        const line = 'process(df.filter("x > 0").collect(), other_arg)';
        const result = neutralizeCode(line);
        assert.ok(!result.includes('.collect()'), '.collect() should not execute');
        assert.ok(result.includes('_catalystops_capture(df.filter("x > 0"))'), 'df expr should be captured');
        assert.ok(result.includes('other_arg'), 'remaining args should be preserved');
    });

    test('should handle strings with parens inside outer call correctly', () => {
        const line = 'print("(nested parens)", df.count())';
        const result = neutralizeCode(line);
        assert.ok(!result.includes('.count()'), '.count() should not execute');
        assert.ok(result.includes('_catalystops_capture(df)'), 'df should be captured');
        assert.ok(result.includes('"(nested parens)"'), 'string with parens should be preserved');
    });

    test('should comment out line when .write is embedded in an outer call (no paren in pattern)', () => {
        const line = 'func(df.write.saveAsTable("t"))';
        const result = neutralizeCode(line);
        // Line is commented out (text preserved in comment, but inactive)
        assert.ok(result.trimStart().startsWith('#'), 'line should be commented out');
        assert.ok(result.includes('[CatalystOps: neutralized]'), 'should carry neutralized marker');
    });

    // --- Magic commands and shell escapes ---

    test('should comment out %sh magic line', () => {
        const result = neutralizeCode('%sh echo hello');
        assert.ok(result.trimStart().startsWith('#'), '%sh should be commented out');
        assert.ok(!result.includes('echo hello\n') || result.includes('# '), 'shell content should not be live Python');
    });

    test('should comment out %sql magic line', () => {
        const result = neutralizeCode('%sql SELECT * FROM table');
        assert.ok(result.trimStart().startsWith('#'), '%sql should be commented out');
    });

    test('should comment out %pip magic line', () => {
        const result = neutralizeCode('%pip install pandas');
        assert.ok(result.trimStart().startsWith('#'), '%pip should be commented out');
    });

    test('should skip %python magic line but keep following Python code', () => {
        const code = '%python\ndf = spark.read.parquet("path")';
        const result = neutralizeCode(code);
        assert.ok(!result.includes('%python'), '%python magic line should be removed');
        assert.ok(result.includes('df = spark.read.parquet'), 'Python code after %python should be kept');
    });

    test('should drop body of multi-line %sh cell until next separator', () => {
        const code = [
            'df = spark.read.parquet("path")',
            '%sh',
            'echo hello',
            'ls /tmp',
            '# COMMAND ----------',
            'df.count()',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(result.includes('df = spark.read.parquet'), 'Python code before %sh kept');
        assert.ok(!result.includes('echo hello'), 'shell body line should be dropped');
        assert.ok(!result.includes('ls /tmp'), 'shell body line should be dropped');
        assert.ok(result.includes('_catalystops_capture(df)'), 'Python code after separator kept and neutralized');
    });

    test('should comment out any line starting with !', () => {
        const cases = ['!ls -la', '!pip install numpy', '!echo hello'];
        for (const line of cases) {
            const result = neutralizeCode(line);
            assert.ok(result.trimStart().startsWith('#'), `"${line}" should be commented out`);
        }
    });

    test('should neutralize # MAGIC %sh (Databricks strips prefix before execution)', () => {
        const result = neutralizeCode('# MAGIC %sh echo hello');
        // Must not start with "# MAGIC" — that prefix would be stripped by Databricks, exposing %sh
        assert.ok(!result.trimStart().startsWith('# MAGIC'), 'line must not retain # MAGIC prefix');
        assert.ok(result.includes('[CatalystOps: skipped]'), 'line should be marked as skipped');
    });

    test('should drop body of # MAGIC %sh cell until next separator', () => {
        const code = [
            '# MAGIC %sh',
            '# MAGIC echo hello',
            '# MAGIC ls /tmp',
            '# COMMAND ----------',
            'df = spark.read.parquet("path")',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(!result.includes('echo hello'), 'shell body should be dropped');
        assert.ok(!result.includes('ls /tmp'), 'shell body should be dropped');
        assert.ok(result.includes('df = spark.read.parquet'), 'Python after separator kept');
    });

    test('should neutralize # MAGIC %sql cell', () => {
        const code = [
            '# MAGIC %sql',
            '# MAGIC SELECT * FROM table',
            '# COMMAND ----------',
            'df = spark.read.parquet("path")',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(!result.includes('SELECT'), 'SQL body should be dropped');
        assert.ok(result.includes('df = spark.read.parquet'), 'Python after separator kept');
    });

    test('should neutralize # MAGIC !cmd', () => {
        const result = neutralizeCode('# MAGIC !pip install pandas');
        assert.ok(!result.trimStart().startsWith('# MAGIC'), 'line must not retain # MAGIC prefix');
        assert.ok(result.includes('[CatalystOps: skipped]'), 'line should be marked as skipped');
    });

    test('should handle mixed magic and Python cells', () => {
        const code = [
            'a = 1',
            '# COMMAND ----------',
            '%sql SELECT 1',
            '# COMMAND ----------',
            'b = 2',
        ].join('\n');
        const result = neutralizeCode(code);
        assert.ok(result.includes('a = 1'), 'first Python cell kept');
        assert.ok(result.includes('b = 2'), 'last Python cell kept');
        assert.ok(!result.includes('SELECT 1') || result.includes('# '), 'SQL magic commented out');
    });

    // --- Comments are not affected ---

    test('should not neutralize actions inside comments', () => {
        const result = neutralizeCode('# df.collect()');
        assert.strictEqual(result, '# df.collect()', 'commented-out collect should not be replaced');
    });
});
