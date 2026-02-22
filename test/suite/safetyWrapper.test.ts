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
        assert.ok(!result.includes('query.awaitTermination()'), 'awaitTermination should be removed');
        assert.ok(result.includes('# [CatalystOps: neutralized]'), 'should be commented out');
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

    // --- Comments are not affected ---

    test('should not neutralize actions inside comments', () => {
        const result = neutralizeCode('# df.collect()');
        assert.strictEqual(result, '# df.collect()', 'commented-out collect should not be replaced');
    });
});
