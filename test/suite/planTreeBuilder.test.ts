/**
 * Tests for Plan Tree Builder
 */

import * as assert from 'assert';
import { buildPlanTrees, getSeverity, PlanNode } from '../../vscode/analysis/planTreeBuilder';
import { AnalysisResult } from '../../vscode/models/types';
import { PlanIssue } from '../../vscode/analysis/planParser';

// Minimal AnalysisResult factory
function makeResult(physicalPlan: string, dataframeName?: string): AnalysisResult {
    return {
        analysisTime: new Date().toISOString(),
        dataframeName,
        summary: { critical: 0, warnings: 0, info: 0, suggestions: 0 },
        cluster: {
            workers: 2, coresPerWorker: 4, totalCores: 8,
            executorMemory: '8g', driverMemory: '8g',
            sparkVersion: '3.4.0', photonEnabled: false,
            adaptiveQueryEnabled: false, sparkConfigs: {},
        },
        executionPlan: {
            physicalPlan,
            logicalPlan: '',
            operators: [],
            totalStages: 1,
            totalShuffles: 0,
            joinCount: 0,
            aggregationCount: 0,
        },
        dataStats: {
            partitionCount: 10, columnCount: 5,
            hasNestedTypes: false, nullPercentages: {},
            partitionSizes: [],
        },
        issues: [],
        metadata: {},
    };
}

suite('Plan Tree Builder', () => {

    test('single root node plan: correct operatorName, no children', () => {
        const plan = `== Physical Plan ==
*(1) FileScan parquet default.table[id#10]`;
        const results = [makeResult(plan, 'df1')];
        const roots = buildPlanTrees(results, [], new Map());

        assert.strictEqual(roots.length, 1, 'Should have 1 root node');
        assert.strictEqual(roots[0].operatorName, 'Read: table');
        assert.strictEqual(roots[0].children.length, 0);
        assert.strictEqual(roots[0].depth, 0);
    });

    test('SortMergeJoin with 2 Exchange subtrees: correct depth and children count', () => {
        const plan = `== Physical Plan ==
*(5) SortMergeJoin [key#10], [key#20], Inner
:- *(2) Sort [key#10 ASC], false, 0
:  +- *(1) Exchange hashpartitioning(key#10, 200)
:     +- *(1) FileScan parquet default.t1[key#10]
+- *(4) Sort [key#20 ASC], false, 0
   +- *(3) Exchange hashpartitioning(key#20, 200)
      +- *(3) FileScan parquet default.t2[key#20]`;
        const results = [makeResult(plan, 'df_join')];
        const roots = buildPlanTrees(results, [], new Map());

        assert.strictEqual(roots.length, 1, 'Should have 1 root');
        const root = roots[0];
        assert.strictEqual(root.operatorName, 'Sort-Merge Join');
        assert.strictEqual(root.depth, 0);
        assert.strictEqual(root.children.length, 2, 'Sort-Merge Join should have 2 Sort children');

        const [leftSort, rightSort] = root.children;
        assert.strictEqual(leftSort.operatorName, 'Sort');
        assert.strictEqual(leftSort.depth, 1);
        assert.strictEqual(leftSort.children.length, 1, 'Sort should have Shuffle child');

        const leftExchange = leftSort.children[0];
        assert.strictEqual(leftExchange.operatorName, 'Shuffle');
        assert.strictEqual(leftExchange.depth, 2);
        assert.strictEqual(leftExchange.children.length, 1);

        assert.strictEqual(rightSort.operatorName, 'Sort');
        assert.strictEqual(rightSort.depth, 1);
    });

    test('issue annotation: SortMergeJoin node gets matched PlanIssue', () => {
        const plan = `== Physical Plan ==
*(5) SortMergeJoin [key#10], [key#20], Inner
:- *(1) FileScan parquet default.t1[key#10]
+- *(2) FileScan parquet default.t2[key#20]`;
        const planIssue: PlanIssue = {
            type: 'join',
            name: 'SortMergeJoin',
            description: 'Sort-merge join is expensive.',
            costPoints: 50,
            planLine: 'SortMergeJoin [key#10], [key#20], Inner',
        };
        const results = [makeResult(plan, 'df1')];
        const roots = buildPlanTrees(results, [planIssue], new Map());

        assert.strictEqual(roots.length, 1);
        assert.ok(roots[0].issue, 'Root SortMergeJoin node should have a matched issue');
        assert.strictEqual(roots[0].issue!.name, 'SortMergeJoin');
        assert.strictEqual(roots[0].issue!.costPoints, 50);
    });

    test('source line: dfLineMap lookup sets sourceLine on root node', () => {
        const plan = `== Physical Plan ==
*(1) FileScan parquet default.table[id#10]`;
        const dfLineMap = new Map<string, number>([['df_orders', 5]]);
        const results = [makeResult(plan, 'df_orders')];
        const roots = buildPlanTrees(results, [], dfLineMap);

        assert.strictEqual(roots.length, 1);
        assert.strictEqual(roots[0].sourceLine, 5, 'Root node should have sourceLine from dfLineMap');
        assert.strictEqual(roots[0].dataframeName, 'df_orders');
    });

    test('AQE plan with Initial Plan section: only Final Plan parsed (no duplicates)', () => {
        const plan = `== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=true
+- *(1) BroadcastHashJoin [id#10], [id#20], Inner, BuildRight
   :- *(1) FileScan parquet default.orders[id#10]
   +- BroadcastExchange HashedRelationBroadcastMode

== Initial Plan ==
SortMergeJoin [id#10], [id#20], Inner
:- Sort [id#10 ASC], false, 0
:  +- Exchange hashpartitioning(id#10, 200)
:     +- FileScan parquet default.orders[id#10]
+- Sort [id#20 ASC], false, 0
   +- Exchange hashpartitioning(id#20, 200)
      +- FileScan parquet default.items[id#20]`;
        const results = [makeResult(plan, 'df1')];
        const roots = buildPlanTrees(results, [], new Map());

        // Should only parse AdaptiveSparkPlan root, not SortMergeJoin from Initial Plan
        assert.ok(roots.length > 0, 'Should have root nodes');
        const allOps = getAllOperators(roots);
        // Initial Plan section is excluded — its SortMergeJoin must not appear
        // (friendly name would be 'Sort-Merge Join', not 'SortMergeJoin')
        const hasSortMergeJoin = allOps.some(op => op === 'Sort-Merge Join');
        assert.ok(!hasSortMergeJoin, 'Initial Plan SortMergeJoin should not appear in results');
    });

    test('empty plan: returns empty array', () => {
        const results = [makeResult('', 'df1')];
        const roots = buildPlanTrees(results, [], new Map());
        assert.strictEqual(roots.length, 0);
    });

    test('header-only plan: returns empty array', () => {
        const plan = `== Physical Plan ==`;
        const results = [makeResult(plan, 'df1')];
        const roots = buildPlanTrees(results, [], new Map());
        assert.strictEqual(roots.length, 0);
    });

    test('getSeverity: critical operators', () => {
        assert.strictEqual(getSeverity('SortMergeJoin'), 'critical');
        assert.strictEqual(getSeverity('CartesianProduct'), 'critical');
        assert.strictEqual(getSeverity('BroadcastNestedLoopJoin'), 'critical');
    });

    test('getSeverity: warning operators', () => {
        assert.strictEqual(getSeverity('Exchange'), 'warning');
        assert.strictEqual(getSeverity('SortAggregate'), 'warning');
    });

    test('getSeverity: info operators', () => {
        assert.strictEqual(getSeverity('BroadcastHashJoin'), 'info');
    });

    test('getSeverity: none for scan/filter/project', () => {
        assert.strictEqual(getSeverity('FileScan'), 'none');
        assert.strictEqual(getSeverity('Filter'), 'none');
        assert.strictEqual(getSeverity('Project'), 'none');
    });

    test('multiple results: trees from each result are merged', () => {
        const plan1 = `== Physical Plan ==\n*(1) FileScan parquet default.t1[id#10]`;
        const plan2 = `== Physical Plan ==\n*(1) FileScan parquet default.t2[id#20]`;
        const results = [
            makeResult(plan1, 'df1'),
            makeResult(plan2, 'df2'),
        ];
        const roots = buildPlanTrees(results, [], new Map());
        assert.strictEqual(roots.length, 2, 'Should have one root per result');
        assert.strictEqual(roots[0].dataframeName, 'df1');
        assert.strictEqual(roots[1].dataframeName, 'df2');
    });

    test('result without physicalPlan: skipped gracefully', () => {
        const result = makeResult('', 'df1');
        result.executionPlan.physicalPlan = '';
        const roots = buildPlanTrees([result], [], new Map());
        assert.strictEqual(roots.length, 0);
    });
});

function getAllOperators(nodes: PlanNode[]): string[] {
    const ops: string[] = [];
    for (const node of nodes) {
        ops.push(node.operatorName);
        ops.push(...getAllOperators(node.children));
    }
    return ops;
}
