/**
 * Analyze a historical Databricks job run:
 * - Fetches run metadata
 * - Reads Spark event logs from DBFS to extract physical plans
 * - Runs plan analysis and surfaces issues in the sidebar
 * - Opens a DAG webview and squiggly lines on the source file
 */

import * as vscode from 'vscode';
import { getConnectionConfig } from '../config/settings';
import { listJobs, getLastRun, getRunDetails, getClusterEventLogPath, getJobRunSource, JobSummary, RunSummary } from '../databricks/jobsApi';
import { fetchPlansFromEventLog } from '../databricks/eventLogParser';
import { parsePlan } from '../analysis/planParser';
import { IssuesTreeDataProvider } from '../views/issuesTreeView';
import { JobsTreeDataProvider, JobWithRun } from '../views/jobsTreeView';
import { CodeIssue, Severity, IssueCategory } from '../models/types';
import { PlanIssue } from '../analysis/planParser';
import { buildPlanTrees } from '../analysis/planTreeBuilder';
import { showJobRunDagWebview } from '../views/dagWebview';
import { updateMcpJobRunSnapshot } from '../mcp/mcpState';
import { logDebug, logError } from '../logger';
import { sendEvent } from '../telemetry';
import { AzureCliAuthError, checkAzureCliLogin } from '../databricks/azureCliAuth';

/**
 * Plan issue names that are already surfaced by local static code analysis.
 * These are excluded from the job run DAG so the view highlights only
 * issues that require an actual execution plan to detect.
 *
 * CrossJoin     → CODE_CROSSJOIN_001 (.crossJoin() call)
 * UnionSchemaMismatch → CODE_UNION_001 (.union() without unionByName)
 */
const LOCAL_ANALYSIS_COVERED = new Set<string>([
    'CrossJoin',
    'UnionSchemaMismatch',
]);

export async function refreshJobsList(
    jobsTreeProvider: JobsTreeDataProvider,
): Promise<void> {
    const config = getConnectionConfig();
    if (!config) {
        jobsTreeProvider.setError('Databricks not configured. Run "CatalystOps: Configure Connection" first.');
        return;
    }

    jobsTreeProvider.setLoading(true);
    sendEvent('jobs/refresh_start');

    if (config.authType === 'azure-cli') {
        try {
            await checkAzureCliLogin();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            jobsTreeProvider.setError(message);
            sendEvent('jobs/refresh_failed', { error: message.substring(0, 200) });
            notifyAzureCliLogin();
            return;
        }
    }

    try {
        const jobs = await listJobs(config.host, config.token);

        // Fetch last run for each job in parallel (best-effort)
        const jobsWithRuns: JobWithRun[] = await Promise.all(
            jobs.map(async (job) => {
                try {
                    const lastRun = await getLastRun(config.host, config.token, job.jobId);
                    return { job, lastRun };
                } catch {
                    return { job };
                }
            }),
        );

        jobsTreeProvider.setJobs(jobsWithRuns);
        sendEvent('jobs/refresh_complete', { count: String(jobs.length) });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        jobsTreeProvider.setError(message);
        sendEvent('jobs/refresh_failed', { error: message.substring(0, 200) });
        if (err instanceof AzureCliAuthError) {
            notifyAzureCliLogin();
        }
    }
}

export async function analyzeJobRun(
    context: vscode.ExtensionContext,
    issuesTreeProvider: IssuesTreeDataProvider,
    runId: number,
    jobName: string,
): Promise<void> {
    const config = getConnectionConfig();
    if (!config) {
        vscode.window.showErrorMessage('CatalystOps: Databricks not configured. Run "Configure Connection" first.');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `CatalystOps: Analyzing "${jobName}"`,
        cancellable: false,
    }, async (progress) => {
        try {
            progress.report({ message: 'Fetching run details…', increment: 10 });
            const [run, source] = await Promise.all([
                getRunDetails(config.host, config.token, runId),
                getJobRunSource(config.host, config.token, runId).catch(() => undefined),
            ]);

            progress.report({ message: 'Reading execution plans from event log…', increment: 50 });

            let planIssues: PlanIssue[] = [];
            let planEntries: { executionId: number; description: string; physicalPlan: string }[] = [];
            let planCount = 0;

            if (run.clusterId) {
                const logPath = await getClusterEventLogPath(config.host, config.token, run.clusterId);

                if (logPath) {
                    planEntries = await fetchPlansFromEventLog(config.host, config.token, logPath);
                    planCount = planEntries.length;
                    logDebug(`analyzeJobRun: found ${planCount} plan entries`);

                    if (planCount > 0) {
                        logDebug(`analyzeJobRun: ${planCount} plan(s) found, running analysis`);
                        for (const entry of planEntries) {
                            planIssues.push(...parsePlan(entry.physicalPlan));
                        }

                        // Deduplicate by name
                        const seen = new Set<string>();
                        planIssues = planIssues.filter(pi => {
                            const key = `${pi.name}:${pi.tableName ?? ''}`;
                            if (seen.has(key)) { return false; }
                            seen.add(key);
                            return true;
                        });

                        // Remove issues that local static analysis already covers —
                        // the DAG should highlight only plan-exclusive findings.
                        planIssues = planIssues.filter(pi => !LOCAL_ANALYSIS_COVERED.has(pi.name));
                    } else {
                        void vscode.window.showWarningMessage(
                            `CatalystOps: No SQL execution plans found in the event log for "${jobName}". ` +
                            'The job may not have executed any Spark SQL or DataFrame operations, or the event log may be empty.',
                        );
                    }
                } else {
                    void vscode.window.showErrorMessage(
                        `CatalystOps: No event log found for "${jobName}".`,
                        'How to enable',
                    ).then(action => {
                        if (action === 'How to enable') {
                            void vscode.window.showInformationMessage(
                                'To enable event logs: open your cluster in Databricks → Advanced Options → Logging → ' +
                                'set Destination to DBFS and a Log Path (e.g. dbfs:/cluster-logs). ' +
                                'Then restart the cluster and re-run the job.',
                            );
                        }
                    });
                }
            } else {
                planIssues = [];
                void vscode.window.showErrorMessage(
                    `CatalystOps: "${jobName}" ran on serverless compute. ` +
                    'Serverless jobs do not write Spark event logs to DBFS, so historical plan analysis is not available. ' +
                    'Use the Dry Run command on the source file for plan analysis.',
                );
            }

            progress.report({ message: 'Building plan view…', increment: 30 });

            // Build PlanNodes from fake AnalysisResult objects
            const fakeResults = planEntries.map(e => ({
                analysisTime: '',
                dataframeName: e.description || `Query ${e.executionId}`,
                summary: {} as any,
                cluster: {} as any,
                executionPlan: { physicalPlan: e.physicalPlan, logicalPlan: '' } as any,
                dataStats: {} as any,
                issues: [],
                metadata: {},
            }));

            const planNodes = buildPlanTrees(fakeResults, planIssues, new Map());

            // Open the job run DAG webview
            showJobRunDagWebview(
                context,
                planNodes,
                planIssues,
                jobName,
                run,
                source?.content,
                source?.path,
                planEntries.map(e => ({ description: e.description, physicalPlan: e.physicalPlan })),
            );

            // Persist snapshot for MCP tools
            updateMcpJobRunSnapshot({
                jobName,
                runId: run.runId,
                planEntries: planEntries.map(e => ({ description: e.description, physicalPlan: e.physicalPlan })),
                planIssues,
                updatedAt: new Date(),
            });

            // Update issues tree
            issuesTreeProvider.updateFromCodeIssues(planIssuesToCodeIssues(planIssues));

            sendEvent('job_run/analyzed', {
                jobName,
                state: run.state.life_cycle_state,
                result: run.state.result_state ?? '',
                planCount: String(planCount),
                issueCount: String(planIssues.length),
                durationMs: String(run.durationMs ?? 0),
            });

        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`analyzeJobRun failed: ${message}`);
            sendEvent('job_run/failed', { jobName, error: message.substring(0, 200) });
            vscode.window.showErrorMessage(`CatalystOps: ${message}`);
        }
    });
}

/** Show a notification prompting the user to run `az login`. */
function notifyAzureCliLogin(): void {
    void vscode.window.showErrorMessage(
        'CatalystOps: Azure CLI session expired or not logged in.',
        'Open Terminal',
    ).then(action => {
        if (action === 'Open Terminal') {
            void vscode.commands.executeCommand('workbench.action.terminal.new').then(() => {
                void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: 'az login\n' });
            });
        }
    });
}

/** Convert PlanIssues to CodeIssues at line 0 for sidebar display. */
function planIssuesToCodeIssues(planIssues: PlanIssue[]): CodeIssue[] {
    return planIssues.map(pi => ({
        id: pi.name,
        severity: costPointsToSeverity(pi.costPoints),
        category: IssueCategory.CODE,
        title: pi.name,
        description: pi.description,
        fix: { description: '' },
        line: 0,
        column: 0,
        endLine: 0,
        endColumn: 30,
    }));
}

function costPointsToSeverity(costPoints: number): Severity {
    if (costPoints >= 80) { return Severity.CRITICAL; }
    if (costPoints >= 30) { return Severity.WARNING; }
    if (costPoints >= 10) { return Severity.INFO; }
    return Severity.SUGGESTION;
}

function formatDuration(ms: number): string {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) { return '<1m'; }
    if (mins < 60) { return `${mins}m`; }
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
