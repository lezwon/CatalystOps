/**
 * Tests for billing types: dateRangeForPeriod, computeSummary, periodFromRange.
 * Pure unit tests — no VS Code dependency.
 */

import * as assert from 'assert';
import {
    dateRangeForPeriod,
    computeSummary,
    periodFromRange,
    BillingRow,
} from '../../vscode/billing/billingTypes';

// ---------------------------------------------------------------------------
// dateRangeForPeriod
// ---------------------------------------------------------------------------

suite('dateRangeForPeriod', () => {
    function todayStr(): string {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function diffDays(startDate: string, endDate: string): number {
        return Math.round(
            (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000,
        );
    }

    test('day returns last 24 hours (yesterday through today)', () => {
        const { startDate, endDate } = dateRangeForPeriod('day');
        assert.strictEqual(endDate, todayStr());
        assert.strictEqual(diffDays(startDate, endDate), 1);
    });

    test('week returns last 7 days', () => {
        const { startDate, endDate } = dateRangeForPeriod('week');
        assert.strictEqual(endDate, todayStr());
        assert.strictEqual(diffDays(startDate, endDate), 6);
    });

    test('month returns last 30 days', () => {
        const { startDate, endDate } = dateRangeForPeriod('month');
        assert.strictEqual(endDate, todayStr());
        assert.strictEqual(diffDays(startDate, endDate), 29);
    });
});

// ---------------------------------------------------------------------------
// periodFromRange
// ---------------------------------------------------------------------------

suite('periodFromRange', () => {
    test('identifies day period', () => {
        const { startDate, endDate } = dateRangeForPeriod('day');
        assert.strictEqual(periodFromRange(startDate, endDate), 'day');
    });

    test('identifies week period', () => {
        const { startDate, endDate } = dateRangeForPeriod('week');
        assert.strictEqual(periodFromRange(startDate, endDate), 'week');
    });

    test('identifies month period', () => {
        const { startDate, endDate } = dateRangeForPeriod('month');
        assert.strictEqual(periodFromRange(startDate, endDate), 'month');
    });

    test('returns custom for arbitrary range', () => {
        assert.strictEqual(periodFromRange('2024-01-01', '2024-06-30'), 'custom');
    });
});

// ---------------------------------------------------------------------------
// computeSummary
// ---------------------------------------------------------------------------

const makeRow = (overrides: Partial<BillingRow> = {}): BillingRow => ({
    date: '2024-01-15',
    workloadType: 'JOBS',
    runAs: 'alice@example.com',
    jobId: '123',
    dbus: 1.0,
    dollars: 1.0,
    skuName: 'SKU_A',
    ...overrides,
});

suite('computeSummary', () => {
    const START = '2024-01-01';
    const END   = '2024-01-31';

    test('handles empty rows — all zeros', () => {
        const summary = computeSummary([], START, END);
        assert.strictEqual(summary.totalDollars, 0);
        assert.strictEqual(summary.totalDBUs, 0);
        assert.deepStrictEqual(summary.byUser, []);
        assert.deepStrictEqual(summary.byWorkload, []);
        assert.deepStrictEqual(summary.byJob, []);
        assert.deepStrictEqual(summary.dailyTotals, []);
    });

    test('aggregates by user correctly', () => {
        const rows = [
            makeRow({ runAs: 'alice@example.com', dollars: 5, dbus: 2 }),
            makeRow({ runAs: 'bob@example.com',   dollars: 3, dbus: 1 }),
            makeRow({ runAs: 'alice@example.com', dollars: 2, dbus: 1 }),
        ];
        const summary = computeSummary(rows, START, END);
        assert.strictEqual(summary.byUser.length, 2);
        assert.strictEqual(summary.byUser[0].user, 'alice@example.com');
        assert.strictEqual(summary.byUser[0].dollars, 7);
        assert.strictEqual(summary.byUser[0].dbus, 3);
    });

    test('aggregates by workload', () => {
        const rows = [
            makeRow({ workloadType: 'JOBS', dollars: 10 }),
            makeRow({ workloadType: 'SQL',  dollars: 4  }),
            makeRow({ workloadType: 'JOBS', dollars: 6  }),
        ];
        const summary = computeSummary(rows, START, END);
        const jobs = summary.byWorkload.find(w => w.type === 'JOBS');
        const sql  = summary.byWorkload.find(w => w.type === 'SQL');
        assert.strictEqual(jobs!.dollars, 16);
        assert.strictEqual(sql!.dollars, 4);
    });

    test('sorts byUser descending by dollars', () => {
        const rows = [
            makeRow({ runAs: 'cheap@example.com',     dollars: 1   }),
            makeRow({ runAs: 'expensive@example.com', dollars: 100 }),
            makeRow({ runAs: 'medium@example.com',    dollars: 10  }),
        ];
        const summary = computeSummary(rows, START, END);
        assert.strictEqual(summary.byUser[0].user, 'expensive@example.com');
        assert.strictEqual(summary.byUser[1].user, 'medium@example.com');
        assert.strictEqual(summary.byUser[2].user, 'cheap@example.com');
    });

    test('caps byUser at 10 entries', () => {
        const rows = Array.from({ length: 15 }, (_, i) =>
            makeRow({ runAs: `user${i}@example.com`, dollars: i + 1 }),
        );
        const summary = computeSummary(rows, START, END);
        assert.ok(summary.byUser.length <= 10);
    });

    test('computes totalDollars and totalDBUs correctly', () => {
        const rows = [
            makeRow({ dollars: 5.5, dbus: 2.2 }),
            makeRow({ dollars: 4.5, dbus: 1.8 }),
        ];
        const summary = computeSummary(rows, START, END);
        assert.ok(Math.abs(summary.totalDollars - 10.0) < 0.001);
        assert.ok(Math.abs(summary.totalDBUs    -  4.0) < 0.001);
    });

    test('skips null jobId entries in byJob', () => {
        const rows = [
            makeRow({ jobId: null, dollars: 5 }),
            makeRow({ jobId: '999', dollars: 3, jobName: 'my_job' }),
        ];
        const summary = computeSummary(rows, START, END);
        assert.strictEqual(summary.byJob.length, 1);
        assert.strictEqual(summary.byJob[0].jobId, '999');
    });

    test('stores the supplied date range on summary', () => {
        const summary = computeSummary([], START, END);
        assert.strictEqual(summary.startDate, START);
        assert.strictEqual(summary.endDate, END);
    });

    test('labels arbitrary range as custom', () => {
        const summary = computeSummary([], '2024-01-01', '2024-06-30');
        assert.strictEqual(summary.period, 'custom');
    });
});

// ---------------------------------------------------------------------------
// enrichWithJobNames fallback logic (tests computeSummary job-name behaviour)
// ---------------------------------------------------------------------------

suite('enrichWithJobNames fallback logic', () => {
    test('falls back to "Job <id>" for unknown jobId', () => {
        const row = makeRow({ jobId: '999', jobName: undefined });
        const summary = computeSummary([row], '2024-01-01', '2024-01-31');
        assert.strictEqual(summary.byJob[0].jobName, 'Job 999');
    });

    test('fills jobName for known jobId', () => {
        const row = makeRow({ jobId: '123', jobName: 'pipeline_etl' });
        const summary = computeSummary([row], '2024-01-01', '2024-01-31');
        assert.strictEqual(summary.byJob[0].jobName, 'pipeline_etl');
    });

    test('handles null jobId rows gracefully in byJob', () => {
        const rows = [
            makeRow({ jobId: null }),
            makeRow({ jobId: '42', jobName: 'some_job' }),
        ];
        const summary = computeSummary(rows, '2024-01-01', '2024-01-31');
        assert.strictEqual(summary.byJob.length, 1);
        assert.strictEqual(summary.byJob[0].jobId, '42');
    });
});
