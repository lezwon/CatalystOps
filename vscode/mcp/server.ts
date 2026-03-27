/**
 * CatalystOps MCP Server
 *
 * Exposes CatalystOps analysis data as MCP tools, resources, and prompts.
 * Transport: Streamable HTTP on 127.0.0.1 (OS-assigned port).
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { analyzeCode } from '../analysis/codeAnalyzer';
import { getMcpSnapshot, getMcpJobRunSnapshot } from './mcpState';
import { loadFromCache, cacheKey } from '../billing/billingCache';
import { computeSummary, dateRangeForPeriod } from '../billing/billingTypes';
import { getCachedPlanIssues, getCachedResults, onCacheUpdated, onDryRunError } from '../analysis/analysisCache';
import { logDebug, logError } from '../logger';
import { Severity } from '../models/types';
import { getConnectionConfig } from '../config/settings';
import { listJobs, getLastRun, getRunDetails, getClusterEventLogPath } from '../databricks/jobsApi';
import { listClusters } from '../databricks/clustersApi';
import { fetchPlansFromEventLog } from '../databricks/eventLogParser';
import { parsePlan } from '../analysis/planParser';

let _httpServer: http.Server | undefined;

// ── Severity emoji helpers ─────────────────────────────────────────────────────

function severityEmoji(sev: Severity): string {
    switch (sev) {
        case Severity.CRITICAL: return '🔴';
        case Severity.WARNING: return '🟡';
        case Severity.INFO: return '🔵';
        case Severity.SUGGESTION: return '⚪';
        default: return '⚪';
    }
}

// ── Wait for the analysis cache to update ─────────────────────────────────────

type CacheWaitResult =
    | { ok: true }
    | { ok: false; timedOut: true }
    | { ok: false; error: string };

function waitForCacheUpdate(timeoutMs: number): Promise<CacheWaitResult> {
    return new Promise(resolve => {
        let settled = false;

        const finish = (result: CacheWaitResult) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            successDisposable.dispose();
            errorDisposable.dispose();
            resolve(result);
        };

        const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);

        const successDisposable = onCacheUpdated(() => finish({ ok: true }));
        const errorDisposable  = onDryRunError(msg => finish({ ok: false, error: msg }));
    });
}

// ── Build the McpServer instance with all tools / resources / prompts ──────────

function createMcpServer(context: vscode.ExtensionContext): McpServer {
    const server = new McpServer({
        name: 'catalystops',
        version: '1.0.0',
    });

    // ── Tool: analyze_pyspark ────────────────────────────────────────────────

    server.tool(
        'analyze_pyspark',
        'Run CatalystOps local static analysis on PySpark code. Returns issues (id, severity, line, title, description, fix) without needing a Databricks cluster.',
        { code: z.string().describe('PySpark Python source code to analyze') },
        async ({ code }) => {
            try {
                const issues = analyzeCode(code);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                issueCount: issues.length,
                                issues: issues.map(i => ({
                                    id: i.id,
                                    severity: i.severity,
                                    line: i.line + 1,
                                    column: i.column,
                                    title: i.title,
                                    description: i.description,
                                    fix: i.fix,
                                })),
                            }, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    );

    // ── Tool: get_active_file_issues ─────────────────────────────────────────

    server.tool(
        'get_active_file_issues',
        'Returns CatalystOps local analysis issues for the currently active file in VS Code. Includes file path, issue list with line numbers, severity, and fix suggestions.',
        async () => {
            const snapshot = getMcpSnapshot();
            if (!snapshot) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'No analysis available yet. Open a Python file in VS Code to trigger local analysis.',
                        },
                    ],
                };
            }
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify({
                            filePath: snapshot.filePath,
                            analyzedAt: snapshot.updatedAt.toISOString(),
                            issueCount: snapshot.issues.length,
                            issues: snapshot.issues.map(i => ({
                                id: i.id,
                                severity: i.severity,
                                line: i.line + 1,
                                column: i.column,
                                title: i.title,
                                description: i.description,
                                fix: i.fix,
                            })),
                        }, null, 2),
                    },
                ],
            };
        },
    );

    // ── Tool: get_billing_summary ─────────────────────────────────────────────

    const billingPeriodSchema = {
        period: z.enum(['day', 'week', 'month']).optional().describe("Time period: 'day' (24h), 'week' (7 days), 'month' (30 days). Defaults to 'week'."),
    };

    server.tool(
        'get_billing_summary',
        'Returns Databricks billing summary (totalDollars, DBUs, by user, by job, by workload) from the local 1-hour cache. Returns a message if no cached data is available. Use refresh_billing to force a live fetch.',
        billingPeriodSchema,
        async ({ period }) => {
            const p = period ?? 'week';
            try {
                const { startDate, endDate } = dateRangeForPeriod(p);
                const key = cacheKey(startDate, endDate);
                const rows = await loadFromCache(context, key);
                if (!rows) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `No cached billing data for the '${p}' period (${startDate} to ${endDate}). ` +
                                    'Open the CatalystOps Billing panel in VS Code and click Refresh to fetch live data, ' +
                                    'or call the refresh_billing tool.',
                            },
                        ],
                    };
                }
                const summary = computeSummary(rows, startDate, endDate);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                period: summary.period,
                                startDate: summary.startDate,
                                endDate: summary.endDate,
                                totalDollars: summary.totalDollars,
                                totalDBUs: summary.totalDBUs,
                                byUser: summary.byUser,
                                byJob: summary.byJob,
                                byWorkload: summary.byWorkload,
                            }, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Failed to load billing data: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    );

    // ── Tool: refresh_billing ─────────────────────────────────────────────────

    server.tool(
        'refresh_billing',
        "Forces a live Databricks billing query (bypasses cache) and updates the billing tree view in VS Code. Requires a configured Databricks connection with billing warehouse access.",
        billingPeriodSchema,
        async ({ period }) => {
            const p = period ?? 'week';
            try {
                await vscode.commands.executeCommand('catalystops.refreshBilling');
                const { startDate, endDate } = dateRangeForPeriod(p);
                const key = cacheKey(startDate, endDate);
                const rows = await loadFromCache(context, key);
                if (rows) {
                    const summary = computeSummary(rows, startDate, endDate);
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify({
                                    message: 'Billing data refreshed successfully.',
                                    period: summary.period,
                                    startDate: summary.startDate,
                                    endDate: summary.endDate,
                                    totalDollars: summary.totalDollars,
                                    totalDBUs: summary.totalDBUs,
                                    byUser: summary.byUser,
                                    byJob: summary.byJob,
                                    byWorkload: summary.byWorkload,
                                }, null, 2),
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'Billing refresh triggered. The billing tree view in VS Code has been updated.',
                        },
                    ],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Billing refresh failed: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    );

    // ── Tool: get_plan_analysis ───────────────────────────────────────────────

    server.tool(
        'get_plan_analysis',
        'Returns parsed Catalyst plan issues from the last dry run: join types, shuffle count, repeated scans, cache spills, etc. Returns a message if no dry run has been performed yet.',
        async () => {
            const planIssues = getCachedPlanIssues();
            const results = getCachedResults();
            if (planIssues.length === 0 && results.length === 0) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: 'No dry run results available yet. Run a CatalystOps dry run first (Cmd/Ctrl+Shift+K in a Python file).',
                        },
                    ],
                };
            }
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify({
                            dataframeCount: results.length,
                            planIssueCount: planIssues.length,
                            planIssues: planIssues.map(i => ({
                                type: i.type,
                                name: i.name,
                                description: i.description,
                                costPoints: i.costPoints,
                                tableName: i.tableName,
                            })),
                            dataframes: results.map(r => ({
                                name: r.dataframeName,
                                totalShuffles: r.executionPlan?.totalShuffles,
                                joinCount: r.executionPlan?.joinCount,
                            })),
                        }, null, 2),
                    },
                ],
            };
        },
    );

    // ── Tool: get_last_job_run_analysis ──────────────────────────────────────

    server.tool(
        'get_last_job_run_analysis',
        'Returns the plan issues and execution plan from the most recently analyzed Databricks job run in VS Code. Use this to get suggestions and the full physical plan without re-fetching from Databricks.',
        async () => {
            const snapshot = getMcpJobRunSnapshot();
            if (!snapshot) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: 'No job run analysis available yet. Double-click a job run in the CatalystOps Jobs panel in VS Code to analyze it first.',
                    }],
                };
            }

            const issuesByCost = [...snapshot.planIssues].sort((a, b) => b.costPoints - a.costPoints);

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        jobName: snapshot.jobName,
                        runId: snapshot.runId,
                        analyzedAt: snapshot.updatedAt.toISOString(),
                        queryCount: snapshot.planEntries.length,
                        planIssueCount: snapshot.planIssues.length,
                        planIssues: issuesByCost.map(i => ({
                            type: i.type,
                            name: i.name,
                            description: i.description,
                            costPoints: i.costPoints,
                            tableName: i.tableName ?? null,
                        })),
                        queries: snapshot.planEntries.slice(0, 10).map(e => ({
                            description: e.description.substring(0, 120),
                            physicalPlan: e.physicalPlan.substring(0, 3000),
                        })),
                    }, null, 2),
                }],
            };
        },
    );

    // ── Tool: run_dry_run ─────────────────────────────────────────────────────

    server.tool(
        'run_dry_run',
        'Triggers a Databricks dry run on the active Python file. Requires a Databricks connection. Waits up to 5 minutes for results, then returns the physical/logical plan text and parsed plan issues.',
        async () => {
            try {
                // Set up cache listener BEFORE triggering the run
                const cachePromise = waitForCacheUpdate(5 * 60 * 1000);
                await vscode.commands.executeCommand('catalystops.analyzeCost');
                const result = await cachePromise;

                if (!result.ok) {
                    if ('timedOut' in result) {
                        return {
                            content: [{
                                type: 'text' as const,
                                text: 'Dry run triggered but timed out waiting for results. The run may still be in progress. ' +
                                    'Try calling get_plan_analysis after the run completes.',
                            }],
                        };
                    }
                    return {
                        isError: true,
                        content: [{ type: 'text' as const, text: `Dry run failed: ${'error' in result ? result.error : 'unknown error'}` }],
                    };
                }

                const results = getCachedResults();
                const planIssues = getCachedPlanIssues();

                const planTexts = results.map(r => ({
                    dataframe: r.dataframeName,
                    physicalPlan: r.executionPlan?.physicalPlan ?? '(none)',
                    logicalPlan: r.executionPlan?.logicalPlan ?? '(none)',
                }));

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                message: 'Dry run complete.',
                                dataframeCount: results.length,
                                planIssueCount: planIssues.length,
                                planIssues: planIssues.map(i => ({
                                    type: i.type,
                                    name: i.name,
                                    description: i.description,
                                    costPoints: i.costPoints,
                                    tableName: i.tableName,
                                })),
                                plans: planTexts,
                            }, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Dry run failed: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    );

    // ── Tool: list_clusters ───────────────────────────────────────────────────

    server.tool(
        'list_clusters',
        'Lists interactive Databricks clusters in the workspace with their current state (RUNNING, TERMINATED, PENDING, etc.), Spark version, and access mode. Useful for checking which clusters are available for dry runs or SSH connections.',
        async () => {
            const config = getConnectionConfig();
            if (!config) {
                return {
                    content: [{ type: 'text' as const, text: 'Databricks not configured. Run "CatalystOps: Configure Connection" in VS Code first.' }],
                };
            }
            try {
                const clusters = await listClusters(config.host, config.token);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            clusterCount: clusters.length,
                            clusters: clusters.map(c => ({
                                clusterId: c.clusterId,
                                name: c.clusterName,
                                state: c.state,
                                sparkVersion: c.sparkVersion,
                                numWorkers: c.numWorkers ?? null,
                                singleUserName: c.singleUserName ?? null,
                            })),
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Failed to list clusters: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    );

    // ── Tool: list_job_runs ───────────────────────────────────────────────────

    server.tool(
        'list_job_runs',
        'Lists Databricks workspace jobs and their most recent run status, duration, cluster ID, and result. Use the returned runId with get_job_run_plan to inspect a specific run\'s execution plan.',
        async () => {
            const config = getConnectionConfig();
            if (!config) {
                return {
                    content: [{ type: 'text' as const, text: 'Databricks not configured. Run "CatalystOps: Configure Connection" in VS Code first.' }],
                };
            }
            try {
                const jobs = await listJobs(config.host, config.token);
                const jobsWithRuns = await Promise.all(
                    jobs.map(async (job) => {
                        try {
                            const lastRun = await getLastRun(config.host, config.token, job.jobId);
                            return { job, lastRun };
                        } catch {
                            return { job, lastRun: undefined };
                        }
                    }),
                );
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            jobCount: jobs.length,
                            jobs: jobsWithRuns.map(({ job, lastRun }) => ({
                                jobId: job.jobId,
                                name: job.name,
                                lastRun: lastRun ? {
                                    runId: lastRun.runId,
                                    state: lastRun.state.life_cycle_state,
                                    result: lastRun.state.result_state ?? null,
                                    startedAt: lastRun.startTimeMs ? new Date(lastRun.startTimeMs).toISOString() : null,
                                    durationMs: lastRun.durationMs ?? null,
                                    clusterId: lastRun.clusterId ?? null,
                                } : null,
                            })),
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Failed to list jobs: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    );

    // ── Tool: get_job_run_plan ─────────────────────────────────────────────────

    server.tool(
        'get_job_run_plan',
        'Fetches the Spark execution plans from a historical Databricks job run by reading the cluster event log from DBFS. Returns parsed plan issues (join types, shuffles, missing partition filters, repeated scans) and the raw physical plan text. Use list_job_runs first to get a runId.',
        { runId: z.number().describe('The Databricks run ID to analyze. Get this from list_job_runs.') },
        async ({ runId }) => {
            const config = getConnectionConfig();
            if (!config) {
                return {
                    content: [{ type: 'text' as const, text: 'Databricks not configured. Run "CatalystOps: Configure Connection" in VS Code first.' }],
                };
            }
            try {
                const run = await getRunDetails(config.host, config.token, runId);

                if (!run.clusterId) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                runId,
                                state: run.state.life_cycle_state,
                                result: run.state.result_state ?? null,
                                message: 'Serverless run — event log-based plan analysis is not available. Use run_dry_run on the source file for plan-level analysis.',
                            }, null, 2),
                        }],
                    };
                }

                const logPath = await getClusterEventLogPath(config.host, config.token, run.clusterId);
                if (!logPath) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                runId,
                                clusterId: run.clusterId,
                                message: 'Cluster event logging is not configured. Enable DBFS log delivery in the cluster settings: Advanced options → Logging → Destination: DBFS, Path: dbfs:/cluster-logs.',
                            }, null, 2),
                        }],
                    };
                }

                const planEntries = await fetchPlansFromEventLog(config.host, config.token, logPath);
                if (planEntries.length === 0) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                runId,
                                clusterId: run.clusterId,
                                message: 'No SQL execution plans found in the event log. The job may not have used Spark SQL/DataFrames, or the run may predate when logging was enabled.',
                            }, null, 2),
                        }],
                    };
                }

                // Parse and deduplicate plan issues across all queries
                const seenKeys = new Set<string>();
                const allPlanIssues = planEntries
                    .flatMap(entry => parsePlan(entry.physicalPlan))
                    .filter(pi => {
                        const key = `${pi.name}:${pi.tableName ?? ''}`;
                        if (seenKeys.has(key)) { return false; }
                        seenKeys.add(key);
                        return true;
                    });

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            runId,
                            jobId: run.jobId,
                            state: run.state.life_cycle_state,
                            result: run.state.result_state ?? null,
                            startedAt: run.startTimeMs ? new Date(run.startTimeMs).toISOString() : null,
                            durationMs: run.durationMs ?? null,
                            clusterId: run.clusterId,
                            queryCount: planEntries.length,
                            planIssueCount: allPlanIssues.length,
                            planIssues: allPlanIssues.map(i => ({
                                type: i.type,
                                name: i.name,
                                description: i.description,
                                costPoints: i.costPoints,
                                tableName: i.tableName ?? null,
                            })),
                            queries: planEntries.slice(0, 10).map(e => ({
                                executionId: e.executionId,
                                description: e.description.substring(0, 120),
                                physicalPlan: e.physicalPlan.substring(0, 3000),
                            })),
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Failed to fetch job run plan: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        },
    );

    // ── Resource: catalystops://issues/current ────────────────────────────────

    server.resource(
        'active-file-issues',
        'catalystops://issues/current',
        { description: 'Markdown-formatted local analysis issue list for the currently active file in VS Code.', mimeType: 'text/markdown' },
        async () => {
            const snapshot = getMcpSnapshot();
            if (!snapshot) {
                return {
                    contents: [
                        {
                            uri: 'catalystops://issues/current',
                            mimeType: 'text/markdown',
                            text: '## CatalystOps — Active File Issues\n\nNo analysis available yet. Open a Python file in VS Code.',
                        },
                    ],
                };
            }

            const ts = snapshot.updatedAt.toISOString().replace('T', ' ').substring(0, 19);
            let md = `## CatalystOps — Active File Issues\n\n`;
            md += `**File:** ${snapshot.filePath}\n`;
            md += `**Analyzed:** ${ts}\n\n`;

            if (snapshot.issues.length === 0) {
                md += '_No issues found._\n';
            } else {
                md += `| # | Severity | Line | Issue | Fix Summary |\n`;
                md += `|---|----------|------|-------|-------------|\n`;
                snapshot.issues.forEach((issue, idx) => {
                    const emoji = severityEmoji(issue.severity);
                    const sev = `${emoji} ${issue.severity.charAt(0).toUpperCase() + issue.severity.slice(1)}`;
                    const fixSummary = issue.fix?.description?.substring(0, 60) ?? '';
                    md += `| ${idx + 1} | ${sev} | ${issue.line + 1} | ${issue.title} | ${fixSummary} |\n`;
                });
            }

            return {
                contents: [
                    {
                        uri: 'catalystops://issues/current',
                        mimeType: 'text/markdown',
                        text: md,
                    },
                ],
            };
        },
    );

    // ── Resource: catalystops://plans/last ────────────────────────────────────

    server.resource(
        'last-plan',
        'catalystops://plans/last',
        { description: 'Raw Catalyst physical + analyzed logical plan text from the last dry run, plus plan issues.', mimeType: 'text/plain' },
        async () => {
            const results = getCachedResults();
            const planIssues = getCachedPlanIssues();

            if (results.length === 0) {
                return {
                    contents: [
                        {
                            uri: 'catalystops://plans/last',
                            mimeType: 'text/plain',
                            text: 'No dry run results available yet. Run a CatalystOps dry run first (Cmd/Ctrl+Shift+K in a Python file).',
                        },
                    ],
                };
            }

            let text = `=== CatalystOps Last Dry Run ===\n\n`;
            text += `DataFrames analyzed: ${results.length}\n`;
            text += `Plan issues found: ${planIssues.length}\n\n`;

            if (planIssues.length > 0) {
                text += `--- Plan Issues ---\n`;
                for (const issue of planIssues) {
                    text += `[${issue.type.toUpperCase()}] ${issue.name} (cost: ${issue.costPoints})\n`;
                    text += `  ${issue.description}\n`;
                    if (issue.tableName) { text += `  Table: ${issue.tableName}\n`; }
                    text += '\n';
                }
            }

            for (const result of results) {
                text += `\n${'='.repeat(60)}\n`;
                text += `DataFrame: ${result.dataframeName ?? '(unnamed)'}\n`;
                text += `${'='.repeat(60)}\n\n`;

                if (result.executionPlan?.physicalPlan) {
                    text += `--- Physical Plan ---\n${result.executionPlan.physicalPlan}\n\n`;
                }
                if (result.executionPlan?.logicalPlan) {
                    text += `--- Analyzed Logical Plan ---\n${result.executionPlan.logicalPlan}\n\n`;
                }
            }

            return {
                contents: [
                    {
                        uri: 'catalystops://plans/last',
                        mimeType: 'text/plain',
                        text,
                    },
                ],
            };
        },
    );

    // ── Resource: catalystops://billing/summary ───────────────────────────────

    server.resource(
        'billing-summary',
        'catalystops://billing/summary',
        { description: 'Markdown-formatted billing snapshot from the last cached period.', mimeType: 'text/markdown' },
        async () => {
            // Try to find the most recent cached period (week → day → month)
            for (const p of ['week', 'day', 'month'] as const) {
                const { startDate, endDate } = dateRangeForPeriod(p);
                const key = cacheKey(startDate, endDate);
                const rows = await loadFromCache(context, key);
                if (!rows) { continue; }

                const summary = computeSummary(rows, startDate, endDate);
                let md = `## CatalystOps — Billing Summary\n\n`;
                md += `**Period:** ${summary.startDate} to ${summary.endDate}\n`;
                md += `**Total Cost:** $${summary.totalDollars.toFixed(2)}\n`;
                md += `**Total DBUs:** ${summary.totalDBUs.toFixed(2)}\n\n`;

                if (summary.byUser.length > 0) {
                    md += `### Top Users\n`;
                    md += `| User | DBUs | Cost |\n|------|------|------|\n`;
                    for (const u of summary.byUser.slice(0, 5)) {
                        md += `| ${u.user} | ${u.dbus.toFixed(2)} | $${u.dollars.toFixed(2)} |\n`;
                    }
                    md += '\n';
                }

                if (summary.byWorkload.length > 0) {
                    md += `### By Workload Type\n`;
                    md += `| Type | DBUs | Cost |\n|------|------|------|\n`;
                    for (const w of summary.byWorkload.slice(0, 5)) {
                        md += `| ${w.type} | ${w.dbus.toFixed(2)} | $${w.dollars.toFixed(2)} |\n`;
                    }
                    md += '\n';
                }

                if (summary.byJob.length > 0) {
                    md += `### Top Jobs\n`;
                    md += `| Job | DBUs | Cost |\n|-----|------|------|\n`;
                    for (const j of summary.byJob.slice(0, 5)) {
                        md += `| ${j.jobName} | ${j.dbus.toFixed(2)} | $${j.dollars.toFixed(2)} |\n`;
                    }
                    md += '\n';
                }

                return {
                    contents: [
                        {
                            uri: 'catalystops://billing/summary',
                            mimeType: 'text/markdown',
                            text: md,
                        },
                    ],
                };
            }

            return {
                contents: [
                    {
                        uri: 'catalystops://billing/summary',
                        mimeType: 'text/markdown',
                        text: '## CatalystOps — Billing Summary\n\nNo cached billing data. ' +
                            'Open the CatalystOps Billing panel in VS Code and click Refresh to fetch data.',
                    },
                ],
            };
        },
    );

    // ── Prompt: pyspark_code_review ───────────────────────────────────────────

    server.prompt(
        'pyspark_code_review',
        'Code review template that injects CatalystOps local findings + plan issues as context.',
        async () => {
            const snapshot = getMcpSnapshot();
            const planIssues = getCachedPlanIssues();

            let ctxText = '';

            if (snapshot && snapshot.issues.length > 0) {
                ctxText += `## CatalystOps Local Analysis Findings\n\n`;
                ctxText += `File: ${snapshot.filePath}\n`;
                ctxText += `Analyzed: ${snapshot.updatedAt.toISOString()}\n\n`;
                ctxText += `Issues found (${snapshot.issues.length}):\n`;
                for (const issue of snapshot.issues) {
                    const emoji = severityEmoji(issue.severity);
                    ctxText += `\n### ${emoji} Line ${issue.line + 1}: ${issue.title} [${issue.id}]\n`;
                    ctxText += `**Severity:** ${issue.severity}\n`;
                    ctxText += `**Description:** ${issue.description}\n`;
                    if (issue.fix) {
                        ctxText += `**Fix:** ${issue.fix.description}\n`;
                        if (issue.fix.code) {
                            ctxText += `\`\`\`python\n${issue.fix.code}\n\`\`\`\n`;
                        }
                    }
                }
            }

            if (planIssues.length > 0) {
                ctxText += `\n## CatalystOps Plan Analysis Findings\n\n`;
                ctxText += `Plan issues found (${planIssues.length}):\n\n`;
                for (const issue of planIssues) {
                    ctxText += `- **${issue.name}** (${issue.type}, cost: ${issue.costPoints}): ${issue.description}\n`;
                }
            }

            if (!ctxText) {
                ctxText = 'No CatalystOps analysis data available yet. The analysis will run automatically when you open a Python file in VS Code.';
            }

            return {
                messages: [
                    {
                        role: 'user' as const,
                        content: {
                            type: 'text' as const,
                            text: `Please review the following PySpark code and suggest improvements. I have already run CatalystOps static analysis — use these findings as context:\n\n${ctxText}\n\nPlease now review the code holistically and provide specific, actionable recommendations to fix the identified issues and improve overall Spark performance.`,
                        },
                    },
                ],
            };
        },
    );

    // ── Prompt: optimize_spark_plan ───────────────────────────────────────────

    server.prompt(
        'optimize_spark_plan',
        'Template that injects the raw Catalyst plan text and asks the model to identify optimization opportunities.',
        async () => {
            const results = getCachedResults();
            const planIssues = getCachedPlanIssues();

            if (results.length === 0) {
                return {
                    messages: [
                        {
                            role: 'user' as const,
                            content: {
                                type: 'text' as const,
                                text: 'No Catalyst plan data available yet. Run a CatalystOps dry run first (Cmd/Ctrl+Shift+K in a Python file) to generate plan data.',
                            },
                        },
                    ],
                };
            }

            let planText = `## Catalyst Execution Plans\n\n`;

            if (planIssues.length > 0) {
                planText += `### CatalystOps Pre-analyzed Issues\n`;
                for (const issue of planIssues) {
                    planText += `- **${issue.name}** (cost score: ${issue.costPoints}): ${issue.description}\n`;
                }
                planText += '\n';
            }

            for (const result of results) {
                planText += `\n### DataFrame: ${result.dataframeName ?? '(unnamed)'}\n\n`;
                if (result.executionPlan?.physicalPlan) {
                    planText += `#### Physical Plan\n\`\`\`\n${result.executionPlan.physicalPlan}\n\`\`\`\n\n`;
                }
                if (result.executionPlan?.logicalPlan) {
                    planText += `#### Analyzed Logical Plan\n\`\`\`\n${result.executionPlan.logicalPlan}\n\`\`\`\n\n`;
                }
            }

            return {
                messages: [
                    {
                        role: 'user' as const,
                        content: {
                            type: 'text' as const,
                            text: `Please analyze the following Apache Spark Catalyst execution plan(s) and identify optimization opportunities. Focus on:\n1. Join strategies (BroadcastHashJoin vs SortMergeJoin)\n2. Shuffle operations and data movement\n3. Repeated file scans that could be cached\n4. Partition skew and data imbalance\n5. Statistics accuracy and predicate pushdown\n\n${planText}\n\nProvide specific, actionable recommendations with code examples where applicable.`,
                        },
                    },
                ],
            };
        },
    );

    return server;
}

// ── Start / stop the HTTP server ───────────────────────────────────────────────

export async function startMcpServer(context: vscode.ExtensionContext): Promise<number> {
    // _mcpServer is not kept globally — a new McpServer+transport is created per request
    // in stateless mode (sessionIdGenerator: undefined), per the MCP SDK requirement.

    _httpServer = http.createServer(async (req, res) => {
        // CORS headers — required for some MCP clients (Copilot, Inspector, etc.)
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

        // Preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.url !== '/mcp') {
            res.writeHead(404);
            res.end();
            return;
        }

        logDebug(`MCP request: ${req.method} from ${req.headers['user-agent'] ?? 'unknown'}`);

        // GET — SSE notifications (stateless mode doesn't support persistent sessions)
        if (req.method === 'GET') {
            res.writeHead(405, { Allow: 'POST' });
            res.end(JSON.stringify({ error: 'Use POST for stateless MCP requests' }));
            return;
        }

        // DELETE — session termination (no-op in stateless mode)
        if (req.method === 'DELETE') {
            res.writeHead(200);
            res.end();
            return;
        }

        // POST — JSON-RPC. Create a fresh server+transport per request (stateless mode
        // requirement: reusing the same transport across requests corrupts its state).
        if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', async () => {
                let body: unknown;
                if (chunks.length > 0) {
                    try {
                        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    } catch {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                        return;
                    }
                }
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                });
                const server = createMcpServer(context);
                res.on('close', () => {
                    void transport.close();
                    void server.close();
                });
                try {
                    await server.connect(transport);
                    await transport.handleRequest(req as any, res as any, body);
                } catch (err) {
                    logError(`MCP request error: ${err instanceof Error ? err.message : String(err)}`);
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Internal server error' }));
                    }
                }
            });
            return;
        }

        res.writeHead(405, { Allow: 'POST, GET, DELETE, OPTIONS' });
        res.end();
    });

    return new Promise((resolve, reject) => {
        _httpServer!.listen(0, '127.0.0.1', () => {
            const addr = _httpServer!.address() as { port: number } | null;
            if (!addr) { reject(new Error('Failed to get server address')); return; }
            logDebug(`MCP server listening on http://127.0.0.1:${addr.port}/mcp`);
            void writeMcpJson(addr.port);
            resolve(addr.port);
        });
        _httpServer!.on('error', reject);
    });
}

/**
 * Write (or update) .vscode/mcp.json so GitHub Copilot Chat can discover
 * the CatalystOps MCP server without needing registerMcpServerDefinitionProvider.
 * The file is rewritten on every extension start because the port is dynamic.
 */
async function writeMcpJson(port: number): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }

    const vscodeDirUri = vscode.Uri.joinPath(folders[0].uri, '.vscode');
    const mcpJsonUri   = vscode.Uri.joinPath(vscodeDirUri, 'mcp.json');

    // Preserve any existing entries written by the user / other tools
    let config: { servers?: Record<string, unknown> } = {};
    try {
        const raw = await vscode.workspace.fs.readFile(mcpJsonUri);
        config = JSON.parse(Buffer.from(raw).toString('utf-8')) as typeof config;
    } catch { /* file doesn't exist yet — start fresh */ }

    if (!config.servers) { config.servers = {}; }
    config.servers['CatalystOps'] = {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
    };

    try { await vscode.workspace.fs.createDirectory(vscodeDirUri); } catch { /* already exists */ }
    await vscode.workspace.fs.writeFile(
        mcpJsonUri,
        Buffer.from(JSON.stringify(config, null, 2) + '\n'),
    );
    logDebug(`Wrote .vscode/mcp.json — CatalystOps MCP server at port ${port}`);
}

export async function stopMcpServer(): Promise<void> {
    if (_httpServer) {
        await new Promise<void>((resolve) => {
            _httpServer!.close(() => resolve());
        });
        _httpServer = undefined;
    }
}
