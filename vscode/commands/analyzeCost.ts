/**
 * Main "Analyze Cost" command - performs full dry run analysis
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getConnectionConfig } from '../config/settings';
import { ensureClusterRunning } from '../databricks/clusterManager';
import { executeCommand } from '../databricks/commandExecution';
import {
    checkServerlessAvailability,
    uploadScriptToWorkspace,
    deleteWorkspaceFile,
    submitServerlessRun,
    getJobRunPageUrl,
    pollJobRun,
    getJobRunOutput,
    queryActualRunCost,
} from '../databricks/serverlessExecution';
import { generateClusterScript, extractResult } from '../analysis/clusterScript';
import { analyzeCode } from '../analysis/codeAnalyzer';
import { parsePlanFromResults } from '../analysis/planParser';
import { mapResultsToDiagnostics, mapPlanIssuesToDiagnostics } from '../analysis/resultMapper';
import { updateCache, fireDryRunError } from '../analysis/analysisCache';
import { estimateDollarCost, estimateDollarCostFromDuration, estimateDollarCostFromTableStats, costLabel } from '../analysis/costModel';
import { setCodeIssueDiagnostics } from '../providers/diagnosticsProvider';
import { setAnalyzing, setResults, setError, setIdle } from '../views/statusBar';
import { IssuesTreeDataProvider, ProgressStep, ProgressStepStatus } from '../views/issuesTreeView';
import { AnalysisResult, CodeIssue, Severity } from '../models/types';
import { log, logDebug, logError, showOutput } from '../logger';
import { sendEvent, HAS_USED_DRY_RUN_KEY } from '../telemetry';

/** Store the last analysis result for report generation */
let lastAnalysisResult: AnalysisResult[] | undefined;
let lastRawOutput: string | undefined;
/** The processed user Python code (bundled deps + neutralized user code) */
let lastProcessedUserCode: string | undefined;
/** The full cluster script including CatalystOps wrapper boilerplate */
let lastScript: string | undefined;

export function getLastAnalysisResult(): AnalysisResult[] | undefined {
    return lastAnalysisResult;
}

export function getLastRawOutput(): string | undefined {
    return lastRawOutput;
}

/**
 * Open the processed user Python script in a temp .py file.
 * Shows only the user-facing Python code, not the CatalystOps wrapper boilerplate.
 */
export async function showGeneratedScript(): Promise<void> {
    if (!lastProcessedUserCode) {
        vscode.window.showWarningMessage('CatalystOps: No script generated yet. Run a dry-run analysis first.');
        return;
    }
    const tmpPath = path.join(os.tmpdir(), 'catalystops_generated.py');
    fs.writeFileSync(tmpPath, lastProcessedUserCode, 'utf-8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
    await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Generate and preview the neutralized user code that would be sent to Databricks,
 * without executing it. Shows only user code — no CatalystOps wrapper boilerplate.
 */
export async function previewDryRunScript(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showWarningMessage('CatalystOps: Open a Python file to preview the script.');
        return;
    }

    const code = editor.document.getText();
    const sourceDir = path.dirname(editor.document.uri.fsPath);
    const { processedUserCode } = generateClusterScript(code, sourceDir);

    const tmpPath = path.join(os.tmpdir(), 'catalystops_dryrun_preview.py');
    fs.writeFileSync(tmpPath, processedUserCode, 'utf-8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
    await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Generate and preview the complete cluster script (user code + CatalystOps wrapper)
 * that would be sent to Databricks, without executing it.
 */
export async function previewFullDryRunScript(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showWarningMessage('CatalystOps: Open a Python file to preview the script.');
        return;
    }

    const code = editor.document.getText();
    const sourceDir = path.dirname(editor.document.uri.fsPath);
    const { script } = generateClusterScript(code, sourceDir);

    const tmpPath = path.join(os.tmpdir(), 'catalystops_full_preview.py');
    fs.writeFileSync(tmpPath, script, 'utf-8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
    await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Open the full cluster script from the most recent dry run (user code + wrapper).
 */
export async function showFullDryRunScript(): Promise<void> {
    if (!lastScript) {
        vscode.window.showWarningMessage('CatalystOps: No script generated yet. Run a dry-run analysis first.');
        return;
    }
    const tmpPath = path.join(os.tmpdir(), 'catalystops_last_full.py');
    fs.writeFileSync(tmpPath, lastScript, 'utf-8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
    await vscode.window.showTextDocument(doc, { preview: true });
}


export async function analyzeCost(
    context: vscode.ExtensionContext,
    issuesTreeProvider: IssuesTreeDataProvider,
): Promise<void> {
    const _dryRunStart = Date.now();
    sendEvent('command/analyze_cost');

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showWarningMessage('CatalystOps: Open a Python file to analyze.');
        return;
    }

    const code = editor.document.getText();
    const filePath = editor.document.uri.fsPath;

    showOutput();
    log(`Starting analysis: ${path.basename(filePath)}`);

    // Step tracking helpers — update the sidebar tree as each stage completes
    const steps: ProgressStep[] = [];
    const addStep = (label: string, status: ProgressStepStatus, detail?: string) => {
        steps.push({ label, status, detail });
        issuesTreeProvider.setProgress(steps);
    };
    const finishStep = (status: ProgressStepStatus, detail?: string) => {
        if (steps.length > 0) {
            const last = steps[steps.length - 1];
            steps[steps.length - 1] = { label: last.label, status, detail: detail ?? last.detail };
            issuesTreeProvider.setProgress([...steps]);
        }
    };

    // Always run local analysis first (instant)
    log('Running local code analysis...');
    addStep('Local analysis', 'running');
    const localIssues = analyzeCode(code);
    log(`Local analysis complete: ${localIssues.length} issue(s) found`);
    finishStep('done', `${localIssues.length} issue(s)`);

    // Show local results immediately so diagnostics are visible while dry run executes
    setCodeIssueDiagnostics(editor.document.uri, localIssues);
    issuesTreeProvider.updateFromCodeIssues(localIssues);
    updateStatusBar(localIssues);

    // Try cluster analysis
    const config = getConnectionConfig();
    const timeoutSeconds = vscode.workspace.getConfiguration('catalystops').get<number>('dryRun.timeoutSeconds', 300);
    const dryRunTimeoutMs = Math.max(timeoutSeconds, 30) * 1000;
    if (!config) {
        // No cluster config — just show local results
        setCodeIssueDiagnostics(editor.document.uri, localIssues);
        issuesTreeProvider.updateFromCodeIssues(localIssues);
        updateStatusBar(localIssues);
        log('No Databricks connection configured — showing local results only');
        setTimeout(() => issuesTreeProvider.clearProgress(), 5000);

        const noConfigMsg = localIssues.length > 0
            ? `CatalystOps: Found ${localIssues.length} local issue${localIssues.length !== 1 ? 's' : ''}. Configure a Databricks connection for deep plan analysis.`
            : 'CatalystOps: No local issues found. Configure a Databricks connection for deep plan analysis.';
        vscode.window.showInformationMessage(noConfigMsg, 'Configure Now').then(action => {
            if (action === 'Configure Now') {
                vscode.commands.executeCommand('catalystops.configureConnection');
            }
        });
        return;
    }

    // Databricks is configured and we're about to run — mark dry run as used
    // so the nudge won't appear again even if this session is interrupted
    void context.globalState.update(HAS_USED_DRY_RUN_KEY, true);

    setAnalyzing();

    try {
        const onPollProgress = (elapsedMs: number) => {
            const secs = Math.floor(elapsedMs / 1000);
            if (steps.length > 0) {
                const last = steps[steps.length - 1];
                steps[steps.length - 1] = { label: last.label, status: 'running', detail: `${secs}s elapsed` };
                issuesTreeProvider.setProgress([...steps]);
            }
        };

        let output: string;
        let serverlessRunPageUrl: string | undefined;
        let serverlessRunId: string | undefined;

        if (config.executionMode === 'serverless') {
            // --- Serverless path ---
            log('Execution mode: serverless');

            addStep('Checking serverless', 'running');
            const availability = await checkServerlessAvailability(config.host, config.token);
            if (!availability.available) {
                finishStep('error', availability.reason);
                log(`Serverless not available: ${availability.reason}`);
                sendEvent('dry_run/serverless_unavailable', { reason: availability.reason ?? 'unknown' });
                const unavailMsg = availability.reason ?? 'Serverless compute not available on this workspace. Databricks Premium tier is required.';
                fireDryRunError(unavailMsg);
                vscode.window.showErrorMessage(`CatalystOps: ${unavailMsg}`);
                setCodeIssueDiagnostics(editor.document.uri, localIssues);
                issuesTreeProvider.updateFromCodeIssues(localIssues);
                updateStatusBar(localIssues);
                setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
                return;
            }
            finishStep('done', 'serverless available');

            addStep('Generating script', 'running');
            const sourceDir = path.dirname(editor.document.uri.fsPath);
            const { script, processedUserCode } = generateClusterScript(code, sourceDir);
            lastProcessedUserCode = processedUserCode;
            lastScript = script;
            log(`Script generated (${script.length} chars)`);
            finishStep('done', `${(script.length / 1024).toFixed(1)} KB`);

            addStep('Uploading script', 'running');
            log('Uploading script to Workspace...');
            const scriptPath = await uploadScriptToWorkspace(config.host, config.token, script);
            log(`Script uploaded to ${scriptPath}`);
            finishStep('done', scriptPath);

            addStep('Running on serverless', 'running');
            log('Submitting serverless run...');
            const runId = await submitServerlessRun(config.host, config.token, scriptPath);
            serverlessRunId = runId;
            log(`Serverless run submitted: run_id=${runId}`);

            // Fetch the run page URL immediately so the user can open the live run UI
            serverlessRunPageUrl = await getJobRunPageUrl(config.host, config.token, runId);
            if (serverlessRunPageUrl) {
                log(`Databricks run UI: ${serverlessRunPageUrl}`);
            }

            // Non-blocking "run started" toast with Open button
            vscode.window.showInformationMessage(
                `CatalystOps: Serverless run started (run_id=${runId})`,
                ...(serverlessRunPageUrl ? ['Open in Databricks'] : []),
            ).then(action => {
                if (action === 'Open in Databricks' && serverlessRunPageUrl) {
                    vscode.env.openExternal(vscode.Uri.parse(serverlessRunPageUrl));
                }
            });

            const { outcome: runOutcome, runPageUrl } = await pollJobRun(config.host, config.token, runId, onPollProgress, dryRunTimeoutMs);
            // Update URL if polling returned a fresher one
            if (runPageUrl) { serverlessRunPageUrl = runPageUrl; }

            if (runOutcome === 'TIMEOUT') {
                finishStep('error', 'timed out');
                logError('Serverless job run timed out');
                setError('Serverless job run timed out');
                fireDryRunError('Serverless job run timed out');
                sendEvent('dry_run/run_timeout', { executionMode: 'serverless' });
                vscode.window.showErrorMessage(
                    'CatalystOps: Serverless job run timed out.',
                    ...(serverlessRunPageUrl ? ['Open in Databricks'] : []),
                ).then(action => {
                    if (action === 'Open in Databricks' && serverlessRunPageUrl) {
                        vscode.env.openExternal(vscode.Uri.parse(serverlessRunPageUrl));
                    }
                });
                setCodeIssueDiagnostics(editor.document.uri, localIssues);
                issuesTreeProvider.updateFromCodeIssues(localIssues);
                setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
                return;
            }

            if (runOutcome === 'FAILED') {
                finishStep('error', 'run failed');
                logError('Serverless job run failed');
                setError('Serverless job run failed');
                fireDryRunError('Serverless job run failed');
                sendEvent('dry_run/run_failed', { executionMode: 'serverless' });
                vscode.window.showErrorMessage(
                    'CatalystOps: Serverless job run failed.',
                    ...(serverlessRunPageUrl ? ['Open in Databricks'] : []),
                ).then(action => {
                    if (action === 'Open in Databricks' && serverlessRunPageUrl) {
                        vscode.env.openExternal(vscode.Uri.parse(serverlessRunPageUrl));
                    }
                });
                setCodeIssueDiagnostics(editor.document.uri, localIssues);
                issuesTreeProvider.updateFromCodeIssues(localIssues);
                setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
                return;
            }
            finishStep('done', `run_id=${runId}`);

            addStep('Fetching output', 'running');
            log(`Fetching output for run_id=${runId}...`);
            output = await getJobRunOutput(config.host, config.token, runId);
            lastRawOutput = output;
            await deleteWorkspaceFile(config.host, config.token, scriptPath);
            finishStep('done');
        } else {
            // --- Cluster path ---
            log(`Checking cluster state (${config.clusterId})...`);
            addStep('Checking cluster', 'running');
            const running = await ensureClusterRunning(config.host, config.token, config.clusterId!);
            if (!running) {
                finishStep('error', 'not ready');
                log('Cluster not ready — aborting cluster analysis');
                sendEvent('dry_run/cluster_not_ready');
                setCodeIssueDiagnostics(editor.document.uri, localIssues);
                issuesTreeProvider.updateFromCodeIssues(localIssues);
                updateStatusBar(localIssues);
                setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
                return;
            }
            log('Cluster is running');
            finishStep('done');

            addStep('Generating script', 'running');
            const sourceDir = path.dirname(editor.document.uri.fsPath);
            const { script, processedUserCode } = generateClusterScript(code, sourceDir);
            lastProcessedUserCode = processedUserCode;
            lastScript = script;
            log(`Script generated (${script.length} chars)`);
            finishStep('done', `${(script.length / 1024).toFixed(1)} KB`);

            addStep('Running on cluster', 'running');
            log('Submitting script to cluster...');
            const result = await executeCommand(config.host, config.token, config.clusterId!, script, onPollProgress, dryRunTimeoutMs);

            if (result.status === 'Error' || result.results?.resultType === 'error') {
                finishStep('error');
                const errorMsg = result.results?.cause || result.results?.data || 'Unknown error';
                logError(`Cluster execution failed: ${errorMsg}`);
                setError(errorMsg.substring(0, 100));
                fireDryRunError(`Cluster execution failed: ${errorMsg}`);
                sendEvent('dry_run/cluster_execution_error', { error: errorMsg.substring(0, 200) });
                vscode.window.showErrorMessage(`CatalystOps cluster analysis failed: ${errorMsg}`);
                setCodeIssueDiagnostics(editor.document.uri, localIssues);
                issuesTreeProvider.updateFromCodeIssues(localIssues);
                setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
                return;
            }
            finishStep('done');

            output = result.results?.data || '';
            lastRawOutput = output;
        }

        // Parse results (common to both paths)
        addStep('Parsing results', 'running');
        log('Parsing results...');
        const parsed = extractResult(output);

        // Collect execution errors/warnings (partial failures, diagnostics entries)
        const execErrors = parsed?.errors ?? [];
        // Diagnostics entries (phase === 'diagnostics') go to debug output only
        const diagEntries = execErrors.filter((e: any) => e.phase === 'diagnostics');
        const actualErrors = execErrors.filter((e: any) => e.phase !== 'diagnostics');
        for (const d of diagEntries) {
            logDebug(`Diagnostics: ${JSON.stringify(d)}`);
        }
        for (const e of actualErrors as any[]) {
            logError(`Execution error: ${e.error || e.traceback || JSON.stringify(e)}`);
        }
        if (actualErrors.length > 0) {
            sendEvent('dry_run/execution_errors', {
                executionMode: config.executionMode,
                errorCount: String(actualErrors.length),
            });
        }

        if (!parsed || parsed.results.length === 0) {
            finishStep('error', 'no DataFrames found');
            sendEvent('dry_run/parse_failed', {
                executionMode: config.executionMode,
                hasOutput: String(!!output),
                hasExecutionErrors: String(actualErrors.length > 0),
            });
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            updateStatusBar(localIssues);
            log('No DataFrames found in output');
            const nodfMsg = actualErrors.length > 0
                ? 'No DataFrames found. Check the Output panel for details.'
                : 'No DataFrames found in script output.';
            fireDryRunError(nodfMsg);
            vscode.window.showErrorMessage(`CatalystOps: ${nodfMsg}`);
            setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
            return;
        }

        // Map cluster results to diagnostics and merge with local issues
        const analysisResults = parsed.results as AnalysisResult[];
        lastAnalysisResult = analysisResults;
        log(`Found ${analysisResults.length} DataFrame(s)`);

        for (const r of analysisResults) {
            logDebug(
                `--- DataFrame: ${r.dataframeName} ---\n` +
                `Physical Plan:\n${r.executionPlan?.physicalPlan || '(none)'}\n` +
                (r.executionPlan?.logicalPlan
                    ? `Logical Plan:\n${r.executionPlan.logicalPlan}\n`
                    : ''),
            );
        }

        // Parse plan issues and update analysis cache (for CodeLens refresh trigger)
        const planIssues = parsePlanFromResults(analysisResults);
        const cluster = analysisResults[0]?.cluster;
        const catalystConfig = vscode.workspace.getConfiguration('catalystops');
        const dbuRate = catalystConfig.get<number>('cost.dbuRatePerHour');
        const serverlessRate = catalystConfig.get<number>('cost.serverlessRatePerHour');
        updateCache(analysisResults, planIssues, editor.document);

        const clusterDiagnostics = mapResultsToDiagnostics(analysisResults, editor.document);
        const planDiagnostics = mapPlanIssuesToDiagnostics(planIssues, editor.document, analysisResults);
        const allIssues = [...localIssues, ...clusterDiagnostics, ...planDiagnostics];

        finishStep('done', `${analysisResults.length} DataFrame(s)`);

        // Cost estimate — three strategies in priority order:
        //   1. Serverless + table stats → data-volume-based estimate (most accurate for serverless)
        //   2. Cluster + planDurationMs  → duration-based estimate (AQE triggered real execution)
        //   3. Fallback                  → heuristic point score
        const tableStats = parsed?.tableStats ?? {};
        const totalBytes = Object.values(tableStats).reduce(
            (s, t) => s + (t.sizeInBytes ?? 0), 0,
        );
        const totalDurationMs = analysisResults.reduce((s, r) => s + (r.planDurationMs ?? 0), 0);

        let runCost;
        let costDetail: string;
        if (config.executionMode === 'serverless' && totalBytes > 0) {
            runCost = estimateDollarCostFromTableStats(totalBytes, serverlessRate);
            const totalMB = (totalBytes / 1024 / 1024).toFixed(0);
            const tableCount = Object.keys(tableStats).length;
            costDetail = `${runCost.formatted} (${totalMB} MB across ${tableCount} table${tableCount !== 1 ? 's' : ''})`;
        } else if (totalDurationMs > 0 && (cluster?.totalCores ?? 0) > 1) {
            runCost = estimateDollarCostFromDuration(totalDurationMs, cluster!, dbuRate);
            costDetail = `${runCost.formatted} (${(totalDurationMs / 1000).toFixed(1)}s on ${cluster?.totalCores ?? 0} cores)`;
        } else {
            runCost = estimateDollarCost(planIssues.reduce((s, pi) => s + pi.costPoints, 0), cluster, dbuRate);
            costDetail = runCost.formatted;
        }
        const costLbl = runCost.dollars !== undefined ? costLabel(Math.round(runCost.dollars * 10000)) : '';
        log(`Estimated cost to run: ${costDetail}${costLbl ? ` — ${costLbl}` : ''}`);
        addStep('Estimated cost', 'done', costDetail);

        setCodeIssueDiagnostics(editor.document.uri, allIssues);
        issuesTreeProvider.updateFromCodeIssues(allIssues);
        updateStatusBar(allIssues);

        const totalIssues = allIssues.length;
        const dryRunCount = clusterDiagnostics.length + planDiagnostics.length;
        log(`Analysis complete: ${totalIssues} total issue(s) (${localIssues.length} local, ${dryRunCount} from dry run)`);

        sendEvent('analysis/complete', {
            executionMode: config.executionMode,
            dataframeCount: String(analysisResults.length),
            issueCount: String(totalIssues),
            localIssueCount: String(localIssues.length),
            dryRunIssueCount: String(dryRunCount),
        });

        sendEvent('dry_run/complete', {
            executionMode: config.executionMode,
            dataframeCount: String(analysisResults.length),
            planIssueCount: String(planIssues.length),
            localIssueCount: String(localIssues.length),
            durationMs: String(Date.now() - _dryRunStart),
            costEstimate: runCost.formatted,
            hasTableStats: String(Object.keys(tableStats).length > 0),
        });

        const msg = `CatalystOps: Analysis complete. ${totalIssues} issues found (${localIssues.length} local, ${dryRunCount} from dry run). Estimated cost: ${runCost.formatted}.`;
        vscode.window.showInformationMessage(
            msg,
            ...(serverlessRunPageUrl ? ['Open in Databricks'] : []),
        ).then(action => {
            if (action === 'Open in Databricks' && serverlessRunPageUrl) {
                vscode.env.openExternal(vscode.Uri.parse(serverlessRunPageUrl));
            }
        });

        // Fire billing query in background — doesn't block analysis results.
        // system.billing.usage data typically appears 1–5 minutes after run completion.
        const billingEnabled = catalystConfig.get<boolean>('cost.queryBillingUsage', false);
        if (billingEnabled && config.executionMode === 'serverless' && serverlessRunId) {
            const capturedRunId = serverlessRunId;
            const capturedRunPageUrl = serverlessRunPageUrl;
            const capturedRate = dbuRate ?? 0.40;
            queryActualRunCost(config.host, config.token, capturedRunId).then(billing => {
                if (!billing) { return; }
                const actualDollars = (billing.totalDBUs * capturedRate).toFixed(4);
                const waitNote = billing.waitedSecs ? ` (data arrived after ${billing.waitedSecs}s)` : '';
                log(`Actual run cost: $${actualDollars} · ${billing.totalDBUs.toFixed(4)} ${billing.usageUnit} — ${billing.skuName}${waitNote}`);
                vscode.window.showInformationMessage(
                    `CatalystOps: Actual run cost: $${actualDollars} · ${billing.totalDBUs.toFixed(4)} ${billing.usageUnit} (${billing.skuName})`,
                    ...(capturedRunPageUrl ? ['Open in Databricks'] : []),
                ).then(action => {
                    if (action === 'Open in Databricks' && capturedRunPageUrl) {
                        vscode.env.openExternal(vscode.Uri.parse(capturedRunPageUrl));
                    }
                });
            }).catch(() => { /* best-effort — billing table may not be enabled */ });
        }

        setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(message);
        setError(message.substring(0, 100));
        fireDryRunError(message);
        sendEvent('analysis/failed', {
            executionMode: config?.executionMode ?? 'unknown',
            error: message.substring(0, 200),
        });
        vscode.window.showErrorMessage(`CatalystOps: ${message}`);

        // Mark the last running step as failed
        if (steps.length > 0) {
            const last = steps[steps.length - 1];
            if (last.status === 'running') {
                steps[steps.length - 1] = { ...last, status: 'error' };
                issuesTreeProvider.setProgress([...steps]);
            }
        }

        setCodeIssueDiagnostics(editor.document.uri, localIssues);
        issuesTreeProvider.updateFromCodeIssues(localIssues);
        setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
    }
}

function updateStatusBar(issues: CodeIssue[]): void {
    const critical = issues.filter(i => i.severity === Severity.CRITICAL).length;
    const warnings = issues.filter(i => i.severity === Severity.WARNING).length;
    const info = issues.filter(i => i.severity === Severity.INFO || i.severity === Severity.SUGGESTION).length;
    setResults(critical, warnings, info);
}
