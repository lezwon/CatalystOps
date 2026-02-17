/**
 * Tests for Safety Wrapper
 */

import * as assert from 'assert';
import { neutralizeCode } from '../../vscode/analysis/safetyWrapper';

suite('Safety Wrapper', () => {
    test('should neutralize .collect()', () => {
        const code = 'result = df.collect()';
        const result = neutralizeCode(code);
        assert.ok(!result.includes('.collect()'), 'collect() should be replaced');
        assert.ok(result.includes('.explain'), 'should contain .explain');
    });

    test('should neutralize .show()', () => {
        const code = 'df.show()';
        const result = neutralizeCode(code);
        assert.ok(!result.includes('.show()'), 'show() should be replaced');
        assert.ok(result.includes('.explain'), 'should contain .explain');
    });

    test('should neutralize .toPandas()', () => {
        const code = 'pdf = df.toPandas()';
        const result = neutralizeCode(code);
        assert.ok(!result.includes('.toPandas()'), 'toPandas() should be replaced');
        assert.ok(result.includes('.explain'), 'should contain .explain');
    });

    test('should neutralize display()', () => {
        const code = 'display(df)';
        const result = neutralizeCode(code);
        assert.ok(!result.includes('display(df)'), 'display() should be replaced');
        assert.ok(result.includes('explain'), 'should contain explain');
    });

    test('should neutralize .count()', () => {
        const code = 'n = df.count()';
        const result = neutralizeCode(code);
        assert.ok(!result.includes('.count()'), 'count() should be replaced');
        assert.ok(result.includes('.explain'), 'should contain .explain');
    });

    test('should neutralize writeStream...start()', () => {
        const code = 'df.writeStream.outputMode("append").start()';
        const result = neutralizeCode(code);
        assert.ok(!result.includes('.start()'), 'start() should be replaced');
        assert.ok(result.includes('.explain'), 'should contain .explain');
    });

    test('should leave non-action code unchanged', () => {
        const code = 'df = spark.read.parquet("path")\ndf2 = df.filter(col("x") > 1)';
        const result = neutralizeCode(code);
        assert.strictEqual(result, code, 'non-action code should be unchanged');
    });
});
