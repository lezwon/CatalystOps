/**
 * Orchestrator command: wires cache + fetcher + UI for the billing dashboard.
 */

import * as vscode from 'vscode';
import { BillingPeriod, dateRangeForPeriod, periodFromRange, computeSummary } from '../billing/billingTypes';
import { fetchBillingRows } from '../billing/billingFetcher';
import { cacheKey, loadFromCache, saveToCache } from '../billing/billingCache';
import { BillingTreeDataProvider } from '../views/billingTreeView';
import { showBillingWebview, restoreBillingWebview } from '../views/billingWebview';
import { getConnectionConfig } from '../config/settings';
import { sendEvent } from '../telemetry';

/**
 * Main entry point. Defaults to the last 7 days if no date range is supplied.
 * periodHint: the tab the user explicitly clicked — preserved in the summary so
 * the correct tab stays active even when day/month date ranges coincide.
 */
export async function showBillingDashboard(
    context: vscode.ExtensionContext,
    treeProvider: BillingTreeDataProvider,
    startDate?: string,
    endDate?: string,
    forceRefresh = false,
    periodHint?: BillingPeriod,
): Promise<void> {
    // Default to last 7 days
    if (!startDate || !endDate) {
        const range = dateRangeForPeriod('week');
        startDate = range.startDate;
        endDate = range.endDate;
        periodHint = periodHint ?? 'week';
    }

    const period = periodHint ?? periodFromRange(startDate, endDate);

    sendEvent('billing/dashboard_opened', {
        period,
        force_refresh: String(forceRefresh),
    });

    const config = getConnectionConfig();
    if (!config) {
        treeProvider.setError('Databricks credentials not configured.');
        return;
    }

    treeProvider.setLoading(true);

    const key = cacheKey(startDate, endDate);

    try {
        let rows = forceRefresh ? null : await loadFromCache(context, key);

        if (!rows) {
            const fetchStart = Date.now();
            rows = await fetchBillingRows(config, startDate, endDate, context);
            const durationMs = Date.now() - fetchStart;
            await saveToCache(context, key, rows);

            sendEvent('billing/fetch_complete', {
                period,
                row_count: String(rows.length),
                duration_ms: String(durationMs),
            });
        } else {
            sendEvent('billing/cache_hit', { period });
        }

        const summary = computeSummary(rows, startDate, endDate, period);
        treeProvider.setSummary(summary);

        showBillingWebview(context, summary, (newStart, newEnd, newPeriod, newForceRefresh) => {
            void showBillingDashboard(context, treeProvider, newStart, newEnd, newForceRefresh ?? false, newPeriod);
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        treeProvider.setError(message);
        restoreBillingWebview();
        vscode.window.showErrorMessage(`CatalystOps Billing: ${message}`);
        sendEvent('billing/fetch_failed', {
            period,
            error: message.substring(0, 200),
        });
    }
}
