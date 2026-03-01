/**
 * Billing data types and pure utility functions.
 */

export type BillingPeriod = 'day' | 'week' | 'month' | 'custom';

export interface BillingRow {
    date: string;
    workloadType: string;
    runAs: string;
    jobId: string | null;
    jobName?: string;
    dbus: number;
    dollars: number;
    skuName: string;
}

export interface BillingSummary {
    period: BillingPeriod;
    startDate: string;
    endDate: string;
    totalDollars: number;
    totalDBUs: number;
    byUser: { user: string; dollars: number; dbus: number }[];
    byWorkload: { type: string; dollars: number; dbus: number }[];
    byJob: { jobId: string; jobName: string; dollars: number; dbus: number }[];
    dailyTotals: { date: string; dollars: number }[];
    rows: BillingRow[];
}

/**
 * Returns ISO date strings (YYYY-MM-DD) for a named period.
 * 'day'   → last 24 hours  (yesterday through today, i.e. today − 1 through today)
 * 'week'  → last 7 days    (today − 6 through today)
 * 'month' → last 30 days   (today − 29 through today)
 */
export function dateRangeForPeriod(period: 'day' | 'week' | 'month'): { startDate: string; endDate: string } {
    const today = new Date();
    const endDate = toIsoDate(today);

    const daysBack = period === 'day' ? 1 : period === 'week' ? 6 : 29;
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    return { startDate: toIsoDate(d), endDate };
}

export function toIsoDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Infer the period label from explicit date range.
 * Returns 'day', 'week', or 'custom'.
 */
export function periodFromRange(startDate: string, endDate: string): BillingPeriod {
    const dayRange = dateRangeForPeriod('day');
    if (startDate === dayRange.startDate && endDate === dayRange.endDate) { return 'day'; }
    const weekRange = dateRangeForPeriod('week');
    if (startDate === weekRange.startDate && endDate === weekRange.endDate) { return 'week'; }
    const monthRange = dateRangeForPeriod('month');
    if (startDate === monthRange.startDate && endDate === monthRange.endDate) { return 'month'; }
    return 'custom';
}

/**
 * Aggregates billing rows into a summary for the given explicit date range.
 * Each grouped list is sorted descending by dollars, capped at 10 entries.
 */
export function computeSummary(
    rows: BillingRow[],
    startDate: string,
    endDate: string,
    periodOverride?: BillingPeriod,
): BillingSummary {
    const period = periodOverride ?? periodFromRange(startDate, endDate);

    const totalDollars = rows.reduce((s, r) => s + r.dollars, 0);
    const totalDBUs = rows.reduce((s, r) => s + r.dbus, 0);

    // By user
    const userMap = new Map<string, { dollars: number; dbus: number }>();
    for (const row of rows) {
        const u = row.runAs || '(no identity)';
        const cur = userMap.get(u) ?? { dollars: 0, dbus: 0 };
        userMap.set(u, { dollars: cur.dollars + row.dollars, dbus: cur.dbus + row.dbus });
    }
    const byUser = Array.from(userMap.entries())
        .map(([user, v]) => ({ user, ...v }))
        .sort((a, b) => b.dollars - a.dollars)
        .slice(0, 10);

    // By workload
    const workloadMap = new Map<string, { dollars: number; dbus: number }>();
    for (const row of rows) {
        const t = row.workloadType || 'UNKNOWN';
        const cur = workloadMap.get(t) ?? { dollars: 0, dbus: 0 };
        workloadMap.set(t, { dollars: cur.dollars + row.dollars, dbus: cur.dbus + row.dbus });
    }
    const byWorkload = Array.from(workloadMap.entries())
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.dollars - a.dollars)
        .slice(0, 10);

    // By job
    const jobMap = new Map<string, { jobName: string; dollars: number; dbus: number }>();
    for (const row of rows) {
        if (!row.jobId) { continue; }
        const cur = jobMap.get(row.jobId) ?? { jobName: row.jobName ?? `Job ${row.jobId}`, dollars: 0, dbus: 0 };
        jobMap.set(row.jobId, {
            jobName: row.jobName ?? cur.jobName,
            dollars: cur.dollars + row.dollars,
            dbus: cur.dbus + row.dbus,
        });
    }
    const byJob = Array.from(jobMap.entries())
        .map(([jobId, v]) => ({ jobId, ...v }))
        .sort((a, b) => b.dollars - a.dollars)
        .slice(0, 10);

    // Daily totals
    const dailyMap = new Map<string, number>();
    for (const row of rows) {
        const cur = dailyMap.get(row.date) ?? 0;
        dailyMap.set(row.date, cur + row.dollars);
    }
    const dailyTotals = Array.from(dailyMap.entries())
        .map(([date, dollars]) => ({ date, dollars }))
        .sort((a, b) => a.date.localeCompare(b.date));

    return { period, startDate, endDate, totalDollars, totalDBUs, byUser, byWorkload, byJob, dailyTotals, rows };
}
