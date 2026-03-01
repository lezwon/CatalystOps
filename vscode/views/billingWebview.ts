/**
 * Billing Dashboard Webview — full HTML dashboard with period tabs,
 * a custom date-range picker, and CSS bar charts.
 *
 * Initial load: sets panel.webview.html (full page).
 * Subsequent updates: uses panel.webview.postMessage so VS Code never skips
 * the update due to identical HTML strings (which would leave the loading
 * overlay stuck).
 */

import * as vscode from 'vscode';
import { BillingPeriod, BillingSummary, dateRangeForPeriod } from '../billing/billingTypes';

let currentPanel: vscode.WebviewPanel | undefined;
let onRangeChange: ((startDate: string, endDate: string, period?: 'day' | 'week' | 'month', forceRefresh?: boolean) => void) | undefined;
let currentStartDate = '';
let currentEndDate = '';
let lastSummary: BillingSummary | undefined;

type WebviewMessage =
    | { type: 'changePeriod'; period: 'day' | 'week' | 'month' }
    | { type: 'changeDateRange'; startDate: string; endDate: string }
    | { type: 'refresh' };

// Payload sent via postMessage for DOM-only updates (no full reload)
interface DataUpdatePayload {
    type: 'dataUpdate';
    tabsHtml: string;
    rangeText: string;
    contentHtml: string;
    customDisplay: string;
    startDate: string;
    endDate: string;
}

export function showBillingWebview(
    context: vscode.ExtensionContext,
    summary: BillingSummary,
    rangeChangeHandler: (startDate: string, endDate: string, period?: 'day' | 'week' | 'month', forceRefresh?: boolean) => void,
): void {
    onRangeChange = rangeChangeHandler;
    currentStartDate = summary.startDate;
    currentEndDate = summary.endDate;
    lastSummary = summary;

    if (currentPanel) {
        currentPanel.reveal();
        // Use postMessage to update DOM — avoids VS Code skipping identical html strings
        currentPanel.webview.postMessage(buildUpdatePayload(summary));
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'catalystops.billing',
        'CatalystOps Billing',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    currentPanel.webview.html = generateHtml(summary);

    currentPanel.webview.onDidReceiveMessage(
        (msg: WebviewMessage) => {
            if (!onRangeChange) { return; }
            if (msg.type === 'changePeriod') {
                const range = dateRangeForPeriod(msg.period);
                currentStartDate = range.startDate;
                currentEndDate = range.endDate;
                onRangeChange(range.startDate, range.endDate, msg.period, false);
            } else if (msg.type === 'changeDateRange') {
                currentStartDate = msg.startDate;
                currentEndDate = msg.endDate;
                onRangeChange(msg.startDate, msg.endDate, undefined, true);
            } else if (msg.type === 'refresh') {
                onRangeChange(currentStartDate, currentEndDate, undefined, true);
            }
        },
        undefined,
        context.subscriptions,
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
        onRangeChange = undefined;
        currentStartDate = '';
        currentEndDate = '';
        lastSummary = undefined;
    });
}

/**
 * Called when a fetch fails — restores the last good summary via postMessage
 * so the webview doesn't stay stuck on the loading overlay.
 */
export function restoreBillingWebview(): void {
    if (currentPanel && lastSummary) {
        currentPanel.webview.postMessage(buildUpdatePayload(lastSummary));
    }
}

// ---------------------------------------------------------------------------
// HTML fragment generators (used both for initial render and postMessage)
// ---------------------------------------------------------------------------

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number): string { return n.toFixed(2); }

function barChart(items: { label: string; dollars: number }[], maxDollars: number): string {
    if (items.length === 0) { return '<p class="empty">No data</p>'; }
    return items.map(item => {
        const pct = maxDollars > 0 ? (item.dollars / maxDollars) * 100 : 0;
        return `
        <div class="bar-row">
            <div class="bar-label" title="${esc(item.label)}">${esc(item.label)}</div>
            <div class="bar-track"><div class="bar" style="width:${pct.toFixed(1)}%"></div></div>
            <div class="bar-value">$${fmt(item.dollars)}</div>
        </div>`;
    }).join('');
}

function dailyChart(dailyTotals: { date: string; dollars: number }[]): string {
    if (dailyTotals.length === 0) { return '<p class="empty">No data</p>'; }
    const max = Math.max(...dailyTotals.map(d => d.dollars), 0.01);
    const shown = dailyTotals.slice(-60);
    return `<div class="daily-chart">${shown.map(d => {
        const pct = (d.dollars / max) * 100;
        return `<div class="daily-col" title="${esc(d.date)}: $${fmt(d.dollars)}">
            <div class="daily-fill" style="height:${pct.toFixed(1)}%"></div>
            <div class="daily-lbl">${esc(d.date.slice(5))}</div>
        </div>`;
    }).join('')}</div>`;
}

function generateTabsHtml(summary: BillingSummary): string {
    const tabs: { period: BillingPeriod | 'custom'; label: string }[] = [
        { period: 'day',    label: 'Day' },
        { period: 'week',   label: 'Week' },
        { period: 'month',  label: 'Month' },
        { period: 'custom', label: 'Custom' },
    ];
    return tabs.map(t => {
        const active = t.period === summary.period ? ' active' : '';
        const onclick = t.period === 'custom'
            ? `showCustom(this)`
            : `changePeriod('${t.period}', this)`;
        return `<button class="tab${active}" onclick="${onclick}">${t.label}</button>`;
    }).join('');
}

function generateContentHtml(summary: BillingSummary): string {
    const uniqueUsers = summary.byUser.length;
    const uniqueJobs  = summary.byJob.length;
    const maxUser     = Math.max(...summary.byUser.map(u => u.dollars), 0.01);
    const maxJob      = Math.max(...summary.byJob.map(j => j.dollars), 0.01);
    const maxWorkload = Math.max(...summary.byWorkload.map(w => w.dollars), 0.01);

    return `<div class="cards">
    <div class="card"><div class="val">$${fmt(summary.totalDollars)}</div><div class="lbl">Total Cost</div></div>
    <div class="card"><div class="val">${summary.totalDBUs.toFixed(1)}</div><div class="lbl">DBUs</div></div>
    <div class="card"><div class="val">${uniqueUsers}</div><div class="lbl">Users</div></div>
    <div class="card"><div class="val">${uniqueJobs}</div><div class="lbl">Jobs</div></div>
</div>
<div class="section"><h2>Top Users by Cost</h2>${barChart(summary.byUser.map(u => ({ label: u.user, dollars: u.dollars })), maxUser)}</div>
<div class="section"><h2>Top Jobs by Cost</h2>${barChart(summary.byJob.map(j => ({ label: `${j.jobName} (${j.jobId})`, dollars: j.dollars })), maxJob)}</div>
<div class="section"><h2>By Workload Type</h2>${barChart(summary.byWorkload.map(w => ({ label: w.type, dollars: w.dollars })), maxWorkload)}</div>
<div class="section"><h2>Daily Trend</h2>${dailyChart(summary.dailyTotals)}</div>`;
}

function buildUpdatePayload(summary: BillingSummary): DataUpdatePayload {
    return {
        type: 'dataUpdate',
        tabsHtml: generateTabsHtml(summary),
        rangeText: `${summary.startDate} \u2014 ${summary.endDate}`,
        contentHtml: generateContentHtml(summary),
        customDisplay: summary.period === 'custom' ? 'flex' : 'none',
        startDate: summary.startDate,
        endDate: summary.endDate,
    };
}

// ---------------------------------------------------------------------------
// Full HTML page (initial load only)
// ---------------------------------------------------------------------------

function generateHtml(summary: BillingSummary): string {
    const customDisplay = summary.period === 'custom' ? 'flex' : 'none';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>CatalystOps Billing</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,sans-serif);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;font-size:13px}
h2{font-size:13px;font-weight:600;margin-bottom:10px}
.tabs{display:flex;gap:4px;flex-wrap:wrap}
.tab{padding:4px 12px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:12px}
.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.tab:hover:not(.active){background:var(--vscode-button-secondaryHoverBackground)}
.custom-range{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:10px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border,transparent);border-radius:4px}
.custom-range label{font-size:12px;color:var(--vscode-descriptionForeground)}
.custom-range input[type=date]{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:3px 6px;font-size:12px;color-scheme:dark}
.fetch-btn{padding:4px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;font-size:12px}
.fetch-btn:hover{background:var(--vscode-button-hoverBackground)}
.range{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:12px}
.cards{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.card{flex:1;min-width:90px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border,transparent);border-radius:5px;padding:10px;text-align:center}
.card .val{font-size:18px;font-weight:700;color:var(--vscode-textLink-foreground)}
.card .lbl{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
.section{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border,transparent);border-radius:5px;padding:12px;margin-bottom:12px}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.bar-label{width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;flex-shrink:0}
.bar-track{flex:1;background:var(--vscode-editor-selectionBackground,#264f78);border-radius:2px;height:14px;position:relative;overflow:hidden}
.bar{height:14px;background:var(--vscode-progressBar-background,#0e70c0);border-radius:2px;position:absolute;left:0;top:0}
.bar-value{width:68px;text-align:right;font-size:12px;flex-shrink:0}
.empty{color:var(--vscode-descriptionForeground);font-size:12px;font-style:italic}
.daily-chart{display:flex;align-items:flex-end;gap:2px;height:72px;overflow-x:auto;padding-bottom:2px}
.daily-col{display:flex;flex-direction:column;align-items:center;flex-shrink:0;width:20px;height:100%}
.daily-fill{width:12px;background:var(--vscode-progressBar-background,#0e70c0);border-radius:2px 2px 0 0;margin-top:auto}
.daily-lbl{font-size:8px;color:var(--vscode-descriptionForeground);transform:rotate(-60deg);margin-top:3px;white-space:nowrap}
.loading-overlay{display:flex;align-items:center;justify-content:center;padding:40px 0;color:var(--vscode-descriptionForeground);font-size:13px}
.tabs-row{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.refresh-btn{padding:4px 10px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:12px;margin-left:auto}
.refresh-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
</style>
</head>
<body>
<div class="tabs-row">
  <div class="tabs" id="tabs">${generateTabsHtml(summary)}</div>
  <button class="refresh-btn" onclick="refreshData()" title="Re-fetch from Databricks">\u21bb Refresh</button>
</div>

<div id="custom-range" class="custom-range" style="display:${customDisplay}">
    <label>From</label>
    <input type="date" id="start-date" value="${esc(summary.startDate)}">
    <label>To</label>
    <input type="date" id="end-date" value="${esc(summary.endDate)}">
    <button class="fetch-btn" onclick="fetchCustomRange()">Fetch</button>
</div>

<div class="range" id="range-text">${esc(summary.startDate)} \u2014 ${esc(summary.endDate)}</div>

<div id="content">
${generateContentHtml(summary)}
</div>

<script>
const vscode = acquireVsCodeApi();

// Handle data updates pushed from the extension via postMessage
window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'dataUpdate') {
        document.getElementById('tabs').innerHTML = msg.tabsHtml;
        document.getElementById('range-text').textContent = msg.rangeText;
        document.getElementById('content').innerHTML = msg.contentHtml;
        document.getElementById('custom-range').style.display = msg.customDisplay;
        if (msg.customDisplay !== 'none') {
            document.getElementById('start-date').value = msg.startDate;
            document.getElementById('end-date').value = msg.endDate;
        }
    }
});

function setActiveTab(btn) {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    btn.classList.add('active');
}
function showLoading() {
    document.getElementById('content').innerHTML =
        '<div class="loading-overlay">Fetching billing data\u2026</div>';
}
function changePeriod(p, btn) {
    document.getElementById('custom-range').style.display = 'none';
    setActiveTab(btn);
    showLoading();
    vscode.postMessage({ type: 'changePeriod', period: p });
}
function refreshData() {
    showLoading();
    vscode.postMessage({ type: 'refresh' });
}
function showCustom(btn) {
    setActiveTab(btn);
    document.getElementById('custom-range').style.display = 'flex';
}
function fetchCustomRange() {
    const start = document.getElementById('start-date').value;
    const end   = document.getElementById('end-date').value;
    if (!start || !end) { return; }
    if (start > end) {
        document.getElementById('start-date').style.borderColor = 'red';
        return;
    }
    document.getElementById('start-date').style.borderColor = '';
    vscode.postMessage({ type: 'changeDateRange', startDate: start, endDate: end });
}
document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && document.getElementById('custom-range').style.display !== 'none') {
        fetchCustomRange();
    }
});
</script>
</body>
</html>`;
}
