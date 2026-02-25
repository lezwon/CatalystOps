/**
 * Tests for Plan Parser
 */

import * as assert from 'assert';
import { parsePlan, calculatePlanCost, parsePlanFromResults } from '../../vscode/analysis/planParser';
import { AnalysisResult } from '../../vscode/models/types';

suite('Plan Parser', () => {
    test('should detect BroadcastHashJoin', () => {
        const plan = `
== Physical Plan ==
*(2) BroadcastHashJoin [id#10], [id#20], Inner, BuildRight
:- *(2) Filter isnotnull(id#10)
:  +- *(2) ColumnarToRow
+- BroadcastExchange HashedRelationBroadcastMode
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'BroadcastHashJoin'), 'should detect BroadcastHashJoin');
        const bhj = issues.find(i => i.name === 'BroadcastHashJoin')!;
        assert.strictEqual(bhj.costPoints, 1, 'BroadcastHashJoin should cost 1 point');
    });

    test('should detect SortMergeJoin', () => {
        const plan = `
== Physical Plan ==
*(5) SortMergeJoin [key#10], [key#20], Inner
:- *(2) Sort [key#10 ASC], false, 0
+- *(4) Sort [key#20 ASC], false, 0
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'SortMergeJoin'), 'should detect SortMergeJoin');
        const smj = issues.find(i => i.name === 'SortMergeJoin')!;
        assert.strictEqual(smj.costPoints, 50, 'SortMergeJoin should cost 50 points');
    });

    test('should detect CartesianProduct', () => {
        const plan = `
== Physical Plan ==
CartesianProduct
:- *(1) Filter isnotnull(id#10)
+- *(2) Filter isnotnull(id#20)
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'CartesianProduct'), 'should detect CartesianProduct');
        assert.strictEqual(issues.find(i => i.name === 'CartesianProduct')!.costPoints, 1000);
    });

    test('should detect Exchange (shuffle)', () => {
        const plan = `
== Physical Plan ==
Exchange hashpartitioning(key#10, 200), ENSURE_REQUIREMENTS, [id=#40]
+- *(1) Filter isnotnull(key#10)
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'Exchange'), 'should detect Exchange');
        assert.strictEqual(issues.find(i => i.name === 'Exchange')!.costPoints, 20);
    });

    test('should not count BroadcastExchange as shuffle', () => {
        const plan = `
BroadcastExchange HashedRelationBroadcastMode
+- *(1) Filter isnotnull(id#10)
`;
        const issues = parsePlan(plan);
        assert.ok(!issues.some(i => i.name === 'Exchange'), 'should not detect BroadcastExchange as shuffle');
    });

    test('should calculate total cost', () => {
        const plan = `
*(5) SortMergeJoin [key#10], [key#20], Inner
Exchange hashpartitioning(key#10, 200)
Exchange hashpartitioning(key#20, 200)
`;
        const issues = parsePlan(plan);
        const cost = calculatePlanCost(issues);
        assert.strictEqual(cost, 90, 'SortMergeJoin(50) + 2*Exchange(20) = 90');
    });

    test('should return empty for plan with no issues', () => {
        const plan = `
== Physical Plan ==
*(1) Filter isnotnull(id#10)
+- *(1) ColumnarToRow
   +- FileScan parquet [id#10]
`;
        const issues = parsePlan(plan);
        assert.strictEqual(issues.length, 0, 'should have no issues');
    });
});

// ── Photon node detection ────────────────────────────────────────────────────

suite('Photon Node Detection', () => {

    test('should detect PhotonBroadcastHashJoin as BroadcastHashJoin', () => {
        const plan = `
== Physical Plan ==
PhotonBroadcastHashJoin [id#10], [id#20], Inner, BuildRight
:- PhotonScan parquet db.orders[id#10]
+- BroadcastExchange HashedRelationBroadcastMode
   +- PhotonScan parquet db.customers[id#20]
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'BroadcastHashJoin'), 'should detect PhotonBroadcastHashJoin');
        assert.ok(!issues.some(i => i.name === 'Exchange'), 'BroadcastExchange must not be counted as shuffle');
    });

    test('should detect PhotonSortMergeJoin as SortMergeJoin', () => {
        const plan = `
== Physical Plan ==
PhotonSortMergeJoin [key#10], [key#20], Inner
:- PhotonScan parquet db.table_a[key#10]
+- PhotonScan parquet db.table_b[key#20]
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'SortMergeJoin'), 'should detect PhotonSortMergeJoin');
        assert.strictEqual(issues.find(i => i.name === 'SortMergeJoin')!.costPoints, 50);
    });

    test('should detect PhotonShuffledHashJoin as ShuffledHashJoin', () => {
        const plan = `
== Physical Plan ==
PhotonShuffledHashJoin [key#10], [key#20], Inner
:- PhotonScan parquet db.left[key#10]
+- PhotonScan parquet db.right[key#20]
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'ShuffledHashJoin'), 'should detect PhotonShuffledHashJoin');
    });

    test('should detect PhotonShuffleExchangeSink as Exchange shuffle', () => {
        const plan = `
== Physical Plan ==
PhotonShuffleExchangeSink hashpartitioning(key#10, 200)
+- PhotonScan parquet db.events[key#10]
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'Exchange'), 'should detect PhotonShuffleExchangeSink as shuffle');
    });

    test('should detect PhotonShuffleExchangeSource as Exchange shuffle', () => {
        const plan = `
== Physical Plan ==
PhotonShuffleExchangeSource
`;
        const issues = parsePlan(plan);
        assert.ok(issues.some(i => i.name === 'Exchange'), 'should detect PhotonShuffleExchangeSource as shuffle');
    });

    test('should detect repeated PhotonScan on the same table as RepeatedFileScan', () => {
        const plan = `
== Physical Plan ==
*(1) HashAggregate
+- PhotonScan parquet db.sales[id#10]
*(2) HashAggregate
+- PhotonScan parquet db.sales[id#20]
`;
        const issues = parsePlan(plan);
        const repeated = issues.find(i => i.name === 'RepeatedFileScan');
        assert.ok(repeated, 'should detect repeated PhotonScan as RepeatedFileScan');
        assert.strictEqual(repeated!.tableName, 'db.sales');
    });

    test('should not flag PhotonScan on two different tables', () => {
        const plan = `
== Physical Plan ==
PhotonScan parquet db.orders[id#10]
PhotonScan parquet db.customers[id#20]
`;
        const issues = parsePlan(plan);
        assert.ok(!issues.some(i => i.name === 'RepeatedFileScan'), 'different tables should not trigger RepeatedFileScan');
    });
});

// ── Cross-DataFrame repeated scan detection ──────────────────────────────────

suite('Cross-DataFrame Repeated Scan Detection', () => {

    /** Build a minimal AnalysisResult with the given physical plan text. */
    function makeResult(physicalPlan: string, dataframeName?: string): AnalysisResult {
        return {
            dataframeName,
            executionPlan: {
                physicalPlan,
                logicalPlan: '',
                operators: [],
                totalStages: 0,
                totalShuffles: 0,
                joinCount: 0,
                aggregationCount: 0,
            },
        } as unknown as AnalysisResult;
    }

    test('should detect the same table scanned in two DataFrames', () => {
        const plan1 = '== Physical Plan ==\nFileScan parquet db.events[id#10]';
        const plan2 = '== Physical Plan ==\nFileScan parquet db.events[id#20]';
        const issues = parsePlanFromResults([makeResult(plan1, 'df_a'), makeResult(plan2, 'df_b')]);
        const cross = issues.filter(i => i.name === 'RepeatedFileScan' && i.tableName === 'db.events');
        assert.ok(cross.length > 0, 'should detect cross-DataFrame repeated scan');
    });

    test('should not flag a table scanned in only one DataFrame', () => {
        const plan1 = '== Physical Plan ==\nFileScan parquet db.orders[id#10]';
        const plan2 = '== Physical Plan ==\nFileScan parquet db.customers[id#20]';
        const issues = parsePlanFromResults([makeResult(plan1), makeResult(plan2)]);
        assert.ok(!issues.some(i => i.tableName === 'db.orders' && i.name === 'RepeatedFileScan'),
            'single-DF scan must not be flagged as cross-DF repeated scan');
    });

    test('should include DataFrame names in the issue description', () => {
        const plan = '== Physical Plan ==\nFileScan parquet db.events[id#10]';
        const issues = parsePlanFromResults([makeResult(plan, 'df_hourly'), makeResult(plan, 'df_daily')]);
        const cross = issues.find(i => i.name === 'RepeatedFileScan' && i.tableName === 'db.events');
        assert.ok(cross, 'should find cross-DataFrame scan issue');
        assert.ok(
            cross!.description.includes('df_hourly') || cross!.description.includes('df_daily'),
            'description should mention the DataFrame names',
        );
    });

    test('should ignore the == Initial Plan == section for cross-DataFrame detection', () => {
        const plan1 = '== Physical Plan ==\nFileScan parquet db.events[id#10]';
        const plan2 = `
== Physical Plan ==
FileScan parquet db.other[id#20]
== Initial Plan ==
FileScan parquet db.events[id#10]
`;
        const issues = parsePlanFromResults([makeResult(plan1), makeResult(plan2)]);
        // db.events appears in plan1's final section and plan2's Initial Plan section only
        const crossEvents = issues.filter(i => i.name === 'RepeatedFileScan' && i.tableName === 'db.events');
        assert.strictEqual(crossEvents.length, 0, 'Initial Plan section must be excluded from cross-DF detection');
    });

    test('should assign higher cost points for large tables (> 512 MiB)', () => {
        const largePlan = '== Physical Plan ==\nFileScan parquet db.bigtable[id#10] sizeInBytes=600.0 MiB';
        const issues = parsePlanFromResults([makeResult(largePlan, 'df1'), makeResult(largePlan, 'df2')]);
        const cross = issues.find(i => i.name === 'RepeatedFileScan' && i.tableName === 'db.bigtable');
        assert.ok(cross, 'should find large cross-DF scan');
        assert.strictEqual(cross!.costPoints, 80, 'large cross-DF scan should cost 80 points');
    });

    test('should assign standard cost points for small tables', () => {
        const smallPlan = '== Physical Plan ==\nFileScan parquet db.small[id#10] sizeInBytes=10.0 MiB';
        const issues = parsePlanFromResults([makeResult(smallPlan, 'df1'), makeResult(smallPlan, 'df2')]);
        const cross = issues.find(i => i.name === 'RepeatedFileScan' && i.tableName === 'db.small');
        assert.ok(cross, 'should find small cross-DF scan');
        assert.strictEqual(cross!.costPoints, 40, 'small cross-DF scan should cost 40 points');
    });

    test('should not double-count when same table is also repeated within a single plan', () => {
        // Single DF with the same table twice in its own plan (within-plan) AND shared with another DF
        const planWithRepeat = `
== Physical Plan ==
FileScan parquet db.events[id#10]
FileScan parquet db.events[id#20]
`;
        const planOther = '== Physical Plan ==\nFileScan parquet db.events[id#30]';
        const issues = parsePlanFromResults([makeResult(planWithRepeat, 'df1'), makeResult(planOther, 'df2')]);
        const repeatedScans = issues.filter(i => i.name === 'RepeatedFileScan' && i.tableName === 'db.events');
        // Expect exactly one deduplicated entry for db.events
        assert.strictEqual(repeatedScans.length, 1, 'deduplication should produce exactly one RepeatedFileScan for db.events');
    });
});
