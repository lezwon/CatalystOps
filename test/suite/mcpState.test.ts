/**
 * Tests for MCP state module — pure unit tests, no VS Code dependency.
 */

import * as assert from 'assert';
import {
    getMcpSnapshot,
    getMcpPlanSnapshot,
    updateMcpSnapshot,
    updateMcpPlanSnapshot,
} from '../../vscode/mcp/mcpState';
import { Severity, IssueCategory, CodeIssue, AnalysisResult } from '../../vscode/models/types';
import { PlanIssue } from '../../vscode/analysis/planParser';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeCodeIssue(overrides: Partial<CodeIssue> = {}): CodeIssue {
    return {
        id: 'CODE_COLLECT_001',
        severity: Severity.CRITICAL,
        category: IssueCategory.CODE,
        title: 'collect() Usage',
        description: 'collect() brings all data to the driver',
        fix: { description: 'Use take(1000) instead' },
        line: 5,
        column: 0,
        location: 'Line 6',
        ...overrides,
    };
}

function makePlanIssue(overrides: Partial<PlanIssue> = {}): PlanIssue {
    return {
        type: 'join',
        name: 'SortMergeJoin',
        description: 'Sort-merge join detected',
        costPoints: 50,
        ...overrides,
    };
}

function makeAnalysisResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
    return {
        analysisTime: new Date().toISOString(),
        dataframeName: 'df',
        summary: { critical: 0, warnings: 0, info: 0, suggestions: 0 },
        cluster: {
            workers: 2,
            coresPerWorker: 4,
            totalCores: 8,
            executorMemory: '8g',
            driverMemory: '8g',
            sparkVersion: '3.5',
            photonEnabled: false,
            adaptiveQueryEnabled: true,
            sparkConfigs: {},
        },
        executionPlan: {
            physicalPlan: '== Physical Plan ==\nSortMergeJoin',
            logicalPlan: '== Analyzed Logical Plan ==\nProject',
            operators: [],
            totalStages: 1,
            totalShuffles: 1,
            joinCount: 1,
            aggregationCount: 0,
        },
        dataStats: {
            partitionCount: 200,
            columnCount: 5,
            hasNestedTypes: false,
            nullPercentages: {},
            partitionSizes: [],
        },
        issues: [],
        metadata: {},
        ...overrides,
    };
}

// ── mcpState: issue snapshot ─────────────────────────────────────────────────

suite('MCP State — issue snapshot', () => {
    // Reset snapshot before each test so tests are independent
    setup(() => {
        updateMcpSnapshot({ filePath: '', issues: [], updatedAt: new Date(0) });
    });

    test('getMcpSnapshot returns the last snapshot set by updateMcpSnapshot', () => {
        const now = new Date();
        const issues = [makeCodeIssue()];
        updateMcpSnapshot({ filePath: '/workspace/pipeline.py', issues, updatedAt: now });

        const snap = getMcpSnapshot();
        assert.ok(snap, 'snapshot should not be null after update');
        assert.strictEqual(snap!.filePath, '/workspace/pipeline.py');
        assert.strictEqual(snap!.issues.length, 1);
        assert.strictEqual(snap!.issues[0].id, 'CODE_COLLECT_001');
        assert.strictEqual(snap!.updatedAt, now);
    });

    test('updateMcpSnapshot overwrites the previous snapshot', () => {
        updateMcpSnapshot({
            filePath: '/a.py',
            issues: [makeCodeIssue({ id: 'CODE_UDF_001' })],
            updatedAt: new Date(),
        });
        updateMcpSnapshot({
            filePath: '/b.py',
            issues: [makeCodeIssue({ id: 'CODE_COLLECT_001' }), makeCodeIssue({ id: 'CODE_RDD_001' })],
            updatedAt: new Date(),
        });

        const snap = getMcpSnapshot();
        assert.strictEqual(snap!.filePath, '/b.py');
        assert.strictEqual(snap!.issues.length, 2);
        assert.strictEqual(snap!.issues[0].id, 'CODE_COLLECT_001');
    });

    test('snapshot preserves all fields of each issue', () => {
        const issue = makeCodeIssue({
            id: 'CODE_CROSSJOIN_001',
            severity: Severity.CRITICAL,
            line: 12,
            column: 8,
            title: 'Cross Join Detected',
            description: 'Cross join creates cartesian product',
            fix: { description: 'Add join condition', code: 'df1.join(df2, "key")' },
        });
        updateMcpSnapshot({ filePath: '/test.py', issues: [issue], updatedAt: new Date() });

        const snap = getMcpSnapshot()!;
        const stored = snap.issues[0];
        assert.strictEqual(stored.id, 'CODE_CROSSJOIN_001');
        assert.strictEqual(stored.severity, Severity.CRITICAL);
        assert.strictEqual(stored.line, 12);
        assert.strictEqual(stored.column, 8);
        assert.strictEqual(stored.title, 'Cross Join Detected');
        assert.strictEqual(stored.fix.description, 'Add join condition');
        assert.strictEqual(stored.fix.code, 'df1.join(df2, "key")');
    });

    test('snapshot can hold an empty issues array', () => {
        updateMcpSnapshot({ filePath: '/clean.py', issues: [], updatedAt: new Date() });
        const snap = getMcpSnapshot()!;
        assert.strictEqual(snap.issues.length, 0);
        assert.strictEqual(snap.filePath, '/clean.py');
    });

    test('snapshot preserves multiple issues in order', () => {
        const issues = [
            makeCodeIssue({ id: 'CODE_COLLECT_001', line: 1 }),
            makeCodeIssue({ id: 'CODE_CROSSJOIN_001', line: 5 }),
            makeCodeIssue({ id: 'CODE_UDF_001', line: 10 }),
        ];
        updateMcpSnapshot({ filePath: '/multi.py', issues, updatedAt: new Date() });

        const snap = getMcpSnapshot()!;
        assert.strictEqual(snap.issues.length, 3);
        assert.strictEqual(snap.issues[0].id, 'CODE_COLLECT_001');
        assert.strictEqual(snap.issues[1].id, 'CODE_CROSSJOIN_001');
        assert.strictEqual(snap.issues[2].id, 'CODE_UDF_001');
    });
});

// ── mcpState: plan snapshot ──────────────────────────────────────────────────

suite('MCP State — plan snapshot', () => {
    setup(() => {
        updateMcpPlanSnapshot({ analysisResults: [], planIssues: [], updatedAt: new Date(0) });
    });

    test('getMcpPlanSnapshot returns null-equivalent before any meaningful update', () => {
        const snap = getMcpPlanSnapshot();
        assert.ok(snap !== null, 'returns the empty sentinel set in setup');
        assert.strictEqual(snap!.analysisResults.length, 0);
        assert.strictEqual(snap!.planIssues.length, 0);
    });

    test('updateMcpPlanSnapshot stores results and issues correctly', () => {
        const now = new Date();
        const results = [makeAnalysisResult({ dataframeName: 'events_df' })];
        const planIssues = [makePlanIssue()];

        updateMcpPlanSnapshot({ analysisResults: results, planIssues, updatedAt: now });

        const snap = getMcpPlanSnapshot()!;
        assert.strictEqual(snap.analysisResults.length, 1);
        assert.strictEqual(snap.analysisResults[0].dataframeName, 'events_df');
        assert.strictEqual(snap.planIssues.length, 1);
        assert.strictEqual(snap.planIssues[0].name, 'SortMergeJoin');
        assert.strictEqual(snap.updatedAt, now);
    });

    test('updateMcpPlanSnapshot overwrites the previous plan snapshot', () => {
        updateMcpPlanSnapshot({
            analysisResults: [makeAnalysisResult({ dataframeName: 'first_df' })],
            planIssues: [makePlanIssue({ name: 'CartesianProduct', costPoints: 1000 })],
            updatedAt: new Date(),
        });
        updateMcpPlanSnapshot({
            analysisResults: [makeAnalysisResult({ dataframeName: 'second_df' })],
            planIssues: [],
            updatedAt: new Date(),
        });

        const snap = getMcpPlanSnapshot()!;
        assert.strictEqual(snap.analysisResults[0].dataframeName, 'second_df');
        assert.strictEqual(snap.planIssues.length, 0);
    });

    test('plan snapshot preserves all plan issue fields', () => {
        const issue = makePlanIssue({
            type: 'cache',
            name: 'RepeatedFileScan',
            description: 'Table "events" scanned 2x without caching',
            costPoints: 60,
            tableName: 'my_catalog.events',
        });
        updateMcpPlanSnapshot({ analysisResults: [], planIssues: [issue], updatedAt: new Date() });

        const stored = getMcpPlanSnapshot()!.planIssues[0];
        assert.strictEqual(stored.type, 'cache');
        assert.strictEqual(stored.name, 'RepeatedFileScan');
        assert.strictEqual(stored.costPoints, 60);
        assert.strictEqual(stored.tableName, 'my_catalog.events');
    });

    test('plan snapshot can hold multiple results and issues', () => {
        const results = [
            makeAnalysisResult({ dataframeName: 'df1' }),
            makeAnalysisResult({ dataframeName: 'df2' }),
            makeAnalysisResult({ dataframeName: 'df3' }),
        ];
        const planIssues = [
            makePlanIssue({ name: 'SortMergeJoin', costPoints: 50 }),
            makePlanIssue({ name: 'Exchange', type: 'shuffle', costPoints: 20 }),
        ];
        updateMcpPlanSnapshot({ analysisResults: results, planIssues, updatedAt: new Date() });

        const snap = getMcpPlanSnapshot()!;
        assert.strictEqual(snap.analysisResults.length, 3);
        assert.strictEqual(snap.planIssues.length, 2);
        assert.strictEqual(snap.planIssues[0].name, 'SortMergeJoin');
        assert.strictEqual(snap.planIssues[1].name, 'Exchange');
    });
});

// ── analyze_pyspark tool logic (via analyzeCode) ──────────────────────────────

// The analyze_pyspark MCP tool delegates directly to analyzeCode().
// These tests verify the contract the tool relies on.

import { analyzeCode } from '../../vscode/analysis/codeAnalyzer';

suite('MCP Tool: analyze_pyspark — underlying analyzeCode contract', () => {
    test('returns issues with id, severity, line, title, description, fix for collect()', () => {
        const issues = analyzeCode('data = df.collect()');
        const issue = issues.find(i => i.id === 'CODE_COLLECT_001');
        assert.ok(issue, 'should detect CODE_COLLECT_001');
        assert.ok(typeof issue!.id === 'string', 'id is a string');
        assert.ok(typeof issue!.severity === 'string', 'severity is a string');
        assert.ok(typeof issue!.line === 'number', 'line is a number');
        assert.ok(typeof issue!.title === 'string', 'title is a string');
        assert.ok(typeof issue!.description === 'string', 'description is a string');
        assert.ok(typeof issue!.fix.description === 'string', 'fix.description is a string');
    });

    test('returns empty array for clean code', () => {
        const issues = analyzeCode('df2 = df.filter("active = true")');
        assert.strictEqual(issues.length, 0);
    });

    test('line numbers are 0-based (tool adds +1 for display)', () => {
        const code = 'df2 = df.filter("x = 1")\ndata = df2.collect()';
        const issues = analyzeCode(code);
        const collect = issues.find(i => i.id === 'CODE_COLLECT_001');
        assert.ok(collect, 'collect issue found');
        assert.strictEqual(collect!.line, 1, 'line is 0-based (second line = index 1)');
    });

    test('multiple issues are returned for code with multiple anti-patterns', () => {
        const code = [
            'data = df.collect()',
            'result = df1.crossJoin(df2)',
            'df.rdd.map(lambda r: r)',
        ].join('\n');
        const issues = analyzeCode(code);
        const ids = issues.map(i => i.id);
        assert.ok(ids.includes('CODE_COLLECT_001'), 'collect detected');
        assert.ok(ids.includes('CODE_CROSSJOIN_001'), 'crossJoin detected');
        assert.ok(ids.includes('CODE_RDD_001'), 'rdd detected');
    });
});
