/**
 * Tests for Plan Parser
 */

import * as assert from 'assert';
import { parsePlan, calculatePlanCost } from '../../vscode/analysis/planParser';

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
