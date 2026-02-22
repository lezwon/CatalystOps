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
    uploadScriptToDbfs,
    deleteDbfsFile,
    submitServerlessRun,
    pollJobRun,
    getJobRunOutput,
} from '../databricks/serverlessExecution';
import { generateClusterScript, extractResult } from '../analysis/clusterScript';
import { analyzeCode } from '../analysis/codeAnalyzer';
import { parsePlanFromResults } from '../analysis/planParser';
import { mapResultsToDiagnostics, mapPlanIssuesToDiagnostics } from '../analysis/resultMapper';
import { updateCache } from '../analysis/analysisCache';
import { estimateDollarCost, estimateDollarCostFromDuration, costLabel } from '../analysis/costModel';
import { setCodeIssueDiagnostics } from '../providers/diagnosticsProvider';
import { setAnalyzing, setResults, setError, setIdle } from '../views/statusBar';
import { IssuesTreeDataProvider, ProgressStep, ProgressStepStatus } from '../views/issuesTreeView';
import { AnalysisResult, CodeIssue, Severity } from '../models/types';
import { log, logDebug, logError, showOutput } from '../logger';
import { sendEvent } from '../telemetry';

/** Store the last analysis result for report generation */
let lastAnalysisResult: AnalysisResult[] | undefined;
let lastRawOutput: string | undefined;
/** The processed user Python code (bundled deps + neutralized user code) */
let lastProcessedUserCode: string | undefined;

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
 * Generate and preview the full script that would be sent to Databricks,
 * without executing it. Useful for inspecting neutralization and bundling
 * before committing to a dry run.
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

export async function analyzeCost(
    context: vscode.ExtensionContext,
    issuesTreeProvider: IssuesTreeDataProvider,
): Promise<void> {
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

    // Try cluster analysis
    const config = getConnectionConfig();
    if (!config) {
        // No cluster config — just show local results
        setCodeIssueDiagnostics(editor.document.uri, localIssues);
        issuesTreeProvider.updateFromCodeIssues(localIssues);
        updateStatusBar(localIssues);
        log('No Databricks connection configured — showing local results only');
        setTimeout(() => issuesTreeProvider.clearProgress(), 5000);

        if (localIssues.length > 0) {
            vscode.window.showInformationMessage(
                `CatalystOps: Found ${localIssues.length} local issues. Configure Databricks connection for deep plan analysis.`,
            );
        } else {
            vscode.window.showInformationMessage(
                'CatalystOps: No local issues found. Configure Databricks connection for deep plan analysis.',
            );
        }
        return;
    }

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

        if (config.executionMode === 'serverless') {
            // --- Serverless path ---
            log('Execution mode: serverless');

            addStep('Checking serverless', 'running');
            const availability = await checkServerlessAvailability(config.host, config.token);
            if (!availability.available) {
                finishStep('error', availability.reason);
                log(`Serverless not available: ${availability.reason}`);
                vscode.window.showErrorMessage(
                    `CatalystOps: ${availability.reason ?? 'Serverless compute not available on this workspace. Databricks Premium tier is required.'}`,
                );
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
            log(`Script generated (${script.length} chars)`);
            finishStep('done', `${(script.length / 1024).toFixed(1)} KB`);

            addStep('Uploading script', 'running');
            log('Uploading script to DBFS...');
            const dbfsPath = await uploadScriptToDbfs(config.host, config.token, script);
            log(`Script uploaded to ${dbfsPath}`);
            finishStep('done', dbfsPath);

            addStep('Running on serverless', 'running');
            log('Submitting serverless run...');
            const runId = await submitServerlessRun(config.host, config.token, dbfsPath);
            log(`Serverless run submitted: run_id=${runId}`);
            const runOutcome = await pollJobRun(config.host, config.token, runId, onPollProgress);

            if (runOutcome === 'TIMEOUT') {
                finishStep('error', 'timed out');
                logError('Serverless job run timed out');
                setError('Serverless job run timed out');
                vscode.window.showErrorMessage('CatalystOps: Serverless job run timed out.');
                setCodeIssueDiagnostics(editor.document.uri, localIssues);
                issuesTreeProvider.updateFromCodeIssues(localIssues);
                setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
                return;
            }

            if (runOutcome === 'FAILED') {
                finishStep('error', 'run failed');
                logError('Serverless job run failed');
                setError('Serverless job run failed');
                vscode.window.showErrorMessage('CatalystOps: Serverless job run failed. Check the Databricks Jobs UI for details.');
                setCodeIssueDiagnostics(editor.document.uri, localIssues);
                issuesTreeProvider.updateFromCodeIssues(localIssues);
                setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
                return;
            }
            finishStep('done');

            addStep('Fetching output', 'running');
            log(`Fetching output for run_id=${runId}...`);
            output = await getJobRunOutput(config.host, config.token, runId);
            lastRawOutput = output;
            await deleteDbfsFile(config.host, config.token, dbfsPath);
            finishStep('done');
        } else {
            // --- Cluster path ---
            log(`Checking cluster state (${config.clusterId})...`);
            addStep('Checking cluster', 'running');
            const running = await ensureClusterRunning(config.host, config.token, config.clusterId!);
            if (!running) {
                finishStep('error', 'not ready');
                log('Cluster not ready — aborting cluster analysis');
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
            log(`Script generated (${script.length} chars)`);
            finishStep('done', `${(script.length / 1024).toFixed(1)} KB`);

            addStep('Running on cluster', 'running');
            log('Submitting script to cluster...');
            const result = await executeCommand(config.host, config.token, config.clusterId!, script, onPollProgress);

            if (result.status === 'Error' || result.results?.resultType === 'error') {
                finishStep('error');
                const errorMsg = result.results?.cause || result.results?.data || 'Unknown error';
                logError(`Cluster execution failed: ${errorMsg}`);
                setError(errorMsg.substring(0, 100));
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

        if (!parsed || parsed.results.length === 0) {
            finishStep('error', 'no DataFrames found');
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            updateStatusBar(localIssues);
            log('No DataFrames found in output');
            const nodfMsg = actualErrors.length > 0
                ? 'CatalystOps: No DataFrames found. Check the Output panel for details.'
                : 'CatalystOps: No DataFrames found in script output.';
            vscode.window.showErrorMessage(nodfMsg);
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
        const dbuRate = vscode.workspace.getConfiguration('catalystops')
            .get<number>('cost.dbuRatePerHour');
        updateCache(analysisResults, planIssues, editor.document);

        const clusterDiagnostics = mapResultsToDiagnostics(analysisResults, editor.document);
        const planDiagnostics = mapPlanIssuesToDiagnostics(planIssues, editor.document, analysisResults);
        const allIssues = [...localIssues, ...clusterDiagnostics, ...planDiagnostics];

        finishStep('done', `${analysisResults.length} DataFrame(s)`);

        // Total cost estimate — uses actual measured plan execution duration when
        // available (AQE triggers real execution), otherwise falls back to heuristic.
        const totalDurationMs = analysisResults.reduce((s, r) => s + (r.planDurationMs ?? 0), 0);
        const runCost = totalDurationMs > 0 && cluster
            ? estimateDollarCostFromDuration(totalDurationMs, cluster, dbuRate)
            : estimateDollarCost(planIssues.reduce((s, pi) => s + pi.costPoints, 0), cluster, dbuRate);
        const durationSec = (totalDurationMs / 1000).toFixed(1);
        const costLbl = runCost.dollars !== undefined ? costLabel(Math.round(runCost.dollars * 10000)) : '';
        const costDetail = totalDurationMs > 0
            ? `${runCost.formatted} (${durationSec}s on ${cluster?.totalCores ?? 0} cores)`
            : runCost.formatted;
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

        const msg = `CatalystOps: Analysis complete. ${totalIssues} issues found (${localIssues.length} local, ${dryRunCount} from dry run). Estimated cost: ${runCost.formatted}.`;
        vscode.window.showInformationMessage(msg);
        setTimeout(() => issuesTreeProvider.clearProgress(), 5000);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(message);
        setError(message.substring(0, 100));
        sendEvent('analysis/failed', {
            executionMode: config?.executionMode ?? 'unknown',
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
