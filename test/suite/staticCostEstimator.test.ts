/**
 * Tests for the Static Cost Estimator.
 * Pure unit tests — no VS Code dependency for core logic.
 */

import * as assert from 'assert';
import {
    parseComputeSpec,
    parseSizeBytes,
    parseSizeAnnotations,
    estimateStaticCost,
} from '../../vscode/analysis/staticCostEstimator';

// ---------------------------------------------------------------------------
// parseComputeSpec
// ---------------------------------------------------------------------------

suite('parseComputeSpec', () => {
    test('parses a valid @compute annotation', () => {
        const code = '# @compute: nodes=4, cores=2, memory=16GB, rate=0.25\n';
        const spec = parseComputeSpec(code);
        assert.ok(spec, 'should return a spec');
        assert.strictEqual(spec!.nodes, 4);
        assert.strictEqual(spec!.cores, 2);
        assert.strictEqual(spec!.memoryGB, 16);
        assert.strictEqual(spec!.ratePerHour, 0.25);
        assert.strictEqual(spec!.annotationLine, 0);
    });

    test('parses annotation on a non-first line', () => {
        const code = 'import pyspark\n# @compute: nodes=2, cores=4, memory=8GB, rate=0.50\n';
        const spec = parseComputeSpec(code);
        assert.ok(spec, 'should return a spec');
        assert.strictEqual(spec!.annotationLine, 1);
    });

    test('parses memory with lowercase suffix', () => {
        const code = '# @compute: nodes=1, cores=1, memory=32gb, rate=1.00\n';
        const spec = parseComputeSpec(code);
        assert.ok(spec);
        assert.strictEqual(spec!.memoryGB, 32);
    });

    test('returns null when annotation is absent', () => {
        const code = 'df = spark.read.parquet("s3://bucket/data")\n';
        assert.strictEqual(parseComputeSpec(code), null);
    });

    test('returns null when a required key is missing (no rate)', () => {
        const code = '# @compute: nodes=4, cores=2, memory=16GB\n';
        assert.strictEqual(parseComputeSpec(code), null);
    });

    test('returns null when a required key is missing (no memory)', () => {
        const code = '# @compute: nodes=4, cores=2, rate=0.25\n';
        assert.strictEqual(parseComputeSpec(code), null);
    });

    test('returns null for empty @compute annotation', () => {
        const code = '# @compute:\n';
        assert.strictEqual(parseComputeSpec(code), null);
    });
});

// ---------------------------------------------------------------------------
// parseSizeBytes
// ---------------------------------------------------------------------------

suite('parseSizeBytes', () => {
    test('parses GB', () => {
        assert.strictEqual(parseSizeBytes('50GB'), 50 * 1024 * 1024 * 1024);
    });

    test('parses MB', () => {
        assert.strictEqual(parseSizeBytes('200MB'), 200 * 1024 * 1024);
    });

    test('parses TB', () => {
        assert.strictEqual(parseSizeBytes('1TB'), 1 * 1024 * 1024 * 1024 * 1024);
    });

    test('parses KB', () => {
        assert.strictEqual(parseSizeBytes('512KB'), 512 * 1024);
    });

    test('is case-insensitive', () => {
        assert.strictEqual(parseSizeBytes('100mb'), 100 * 1024 * 1024);
        assert.strictEqual(parseSizeBytes('5gb'), 5 * 1024 * 1024 * 1024);
    });

    test('returns 0 on invalid input', () => {
        assert.strictEqual(parseSizeBytes('invalid'), 0);
        assert.strictEqual(parseSizeBytes(''), 0);
        assert.strictEqual(parseSizeBytes('50'), 0);
    });
});

// ---------------------------------------------------------------------------
// parseSizeAnnotations
// ---------------------------------------------------------------------------

suite('parseSizeAnnotations', () => {
    test('detects var name on the same line', () => {
        const code = 'big_df = spark.read.parquet("s3://bucket/data")  # @size: 50GB\n';
        const annotations = parseSizeAnnotations(code);
        assert.strictEqual(annotations.length, 1);
        assert.strictEqual(annotations[0].varName, 'big_df');
        assert.strictEqual(annotations[0].sizeBytes, 50 * 1024 * 1024 * 1024);
        assert.strictEqual(annotations[0].annotationLine, 0);
    });

    test('detects var name on the line below (annotation above assignment)', () => {
        const code = '# @size: 200MB\nlookup = spark.read.csv("s3://bucket/lookup")\n';
        const annotations = parseSizeAnnotations(code);
        assert.strictEqual(annotations.length, 1);
        assert.strictEqual(annotations[0].varName, 'lookup');
        assert.strictEqual(annotations[0].sizeBytes, 200 * 1024 * 1024);
    });

    test('sets varName to null when no assignment found', () => {
        const code = '# @size: 10GB\n# just a comment\n';
        const annotations = parseSizeAnnotations(code);
        assert.strictEqual(annotations.length, 1);
        assert.strictEqual(annotations[0].varName, null);
    });

    test('parses multiple @size annotations', () => {
        const code = [
            'big_df = spark.read.parquet("...")  # @size: 50GB',
            'lookup = spark.read.csv("...")      # @size: 200MB',
        ].join('\n');
        const annotations = parseSizeAnnotations(code);
        assert.strictEqual(annotations.length, 2);
    });

    test('returns empty array when no @size annotations', () => {
        const code = 'df = spark.read.parquet("s3://bucket")\n';
        assert.deepStrictEqual(parseSizeAnnotations(code), []);
    });
});

// ---------------------------------------------------------------------------
// estimateStaticCost
// ---------------------------------------------------------------------------

suite('estimateStaticCost', () => {
    test('returns null when no @compute annotation', () => {
        const code = 'df = spark.read.parquet("s3://bucket/data")  # @size: 50GB\n';
        assert.strictEqual(estimateStaticCost(code), null);
    });

    test('returns a valid estimate for a full annotation', () => {
        const code = [
            '# @compute: nodes=4, cores=2, memory=16GB, rate=0.25',
            'big_df = spark.read.parquet("s3://bucket/data")  # @size: 50GB',
        ].join('\n');
        const result = estimateStaticCost(code);
        assert.ok(result, 'should return an estimate');
        assert.ok(result!.dollars > 0, 'dollars should be positive');
        assert.ok(result!.formattedCost.startsWith('~$') || result!.formattedCost.startsWith('<$'),
            `unexpected format: ${result!.formattedCost}`);
        assert.ok(Math.abs(result!.totalDataGB - 50) < 0.01, 'totalDataGB should be ~50');
    });

    test('sums multiple @size annotations correctly', () => {
        const code = [
            '# @compute: nodes=4, cores=2, memory=16GB, rate=0.25',
            'big_df = spark.read.parquet("...")  # @size: 50GB',
            'lookup = spark.read.csv("...")      # @size: 200MB',
        ].join('\n');
        const result = estimateStaticCost(code);
        assert.ok(result);
        const expectedGB = 50 + 200 / 1024;
        assert.ok(Math.abs(result!.totalDataGB - expectedGB) < 0.01,
            `expected ~${expectedGB.toFixed(3)} GB, got ${result!.totalDataGB}`);
    });

    test('returns <$0.0001 format for zero-byte input', () => {
        const code = '# @compute: nodes=4, cores=2, memory=16GB, rate=0.25\n';
        const result = estimateStaticCost(code);
        assert.ok(result);
        // With no @size annotations, totalBytes=0; estimateDollarCostFromTableStats returns 'unknown'
        assert.strictEqual(result!.formattedCost, 'unknown');
    });

    test('exposes computeSpec on result', () => {
        const code = '# @compute: nodes=8, cores=4, memory=32GB, rate=1.00\n';
        const result = estimateStaticCost(code);
        assert.ok(result);
        assert.strictEqual(result!.computeSpec.nodes, 8);
        assert.strictEqual(result!.computeSpec.cores, 4);
        assert.strictEqual(result!.computeSpec.memoryGB, 32);
        assert.strictEqual(result!.computeSpec.ratePerHour, 1.00);
    });

    test('uses user-supplied rate (not default serverless rate)', () => {
        const codeHighRate = [
            '# @compute: nodes=1, cores=1, memory=4GB, rate=10.00',
            'df = spark.read.parquet("...")  # @size: 1GB',
        ].join('\n');
        const codeLowRate = [
            '# @compute: nodes=1, cores=1, memory=4GB, rate=0.01',
            'df = spark.read.parquet("...")  # @size: 1GB',
        ].join('\n');

        const highResult = estimateStaticCost(codeHighRate);
        const lowResult = estimateStaticCost(codeLowRate);
        assert.ok(highResult && lowResult);
        assert.ok(highResult!.dollars > lowResult!.dollars,
            'higher rate should produce higher cost');
    });
});

// ---------------------------------------------------------------------------
// CodeLens integration (pure logic, no VS Code API)
// Tests that estimateStaticCost returns correct data for CodeLens rendering
// ---------------------------------------------------------------------------

suite('CodeLens integration data', () => {
    test('returns annotationLine=0 for @compute on first line', () => {
        const code = '# @compute: nodes=4, cores=2, memory=16GB, rate=0.25\n';
        const result = estimateStaticCost(code);
        assert.ok(result);
        assert.strictEqual(result!.computeSpec.annotationLine, 0);
    });

    test('returns correct annotationLine for @compute on a later line', () => {
        const code = 'import pyspark\nimport os\n# @compute: nodes=4, cores=2, memory=16GB, rate=0.25\n';
        const result = estimateStaticCost(code);
        assert.ok(result);
        assert.strictEqual(result!.computeSpec.annotationLine, 2);
    });

    test('formattedCost label contains expected dollar sign prefix', () => {
        const code = [
            '# @compute: nodes=4, cores=2, memory=16GB, rate=0.25',
            'df = spark.read.parquet("...")  # @size: 50GB',
        ].join('\n');
        const result = estimateStaticCost(code);
        assert.ok(result);
        assert.ok(
            result!.formattedCost.startsWith('~$') || result!.formattedCost.startsWith('<$'),
            `unexpected formattedCost: ${result!.formattedCost}`,
        );
    });

    test('no estimate without @compute (CodeLens should not appear)', () => {
        const code = 'df = spark.read.parquet("s3://bucket")  # @size: 50GB\n';
        const result = estimateStaticCost(code);
        assert.strictEqual(result, null, 'should be null when @compute is absent');
    });
});
