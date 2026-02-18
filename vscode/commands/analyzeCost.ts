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
import { generateClusterScript, extractResult } from '../analysis/clusterScript';
import { analyzeCode } from '../analysis/codeAnalyzer';
import { parsePlanFromResults } from '../analysis/planParser';
import { mapResultsToDiagnostics } from '../analysis/resultMapper';
import { updateCache, getAllLineCosts } from '../analysis/analysisCache';
import { estimateDollarCost } from '../analysis/costModel';
import { setCodeIssueDiagnostics } from '../providers/diagnosticsProvider';
import { setAnalyzing, setResults, setError, setIdle } from '../views/statusBar';
import { IssuesTreeDataProvider } from '../views/issuesTreeView';
import { AnalysisResult, CodeIssue, Severity } from '../models/types';
import { log, logError, showOutput } from '../logger';

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

export async function analyzeCost(
    context: vscode.ExtensionContext,
    issuesTreeProvider: IssuesTreeDataProvider,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showWarningMessage('CatalystOps: Open a Python file to analyze.');
        return;
    }

    const code = editor.document.getText();
    const filePath = editor.document.uri.fsPath;

    showOutput();
    log(`Starting analysis: ${path.basename(filePath)}`);

    // Always run local analysis first (instant)
    log('Running local code analysis...');
    const localIssues = analyzeCode(code);
    log(`Local analysis complete: ${localIssues.length} issue(s) found`);

    // Try cluster analysis
    const config = getConnectionConfig();
    if (!config) {
        // No cluster config — just show local results
        setCodeIssueDiagnostics(editor.document.uri, localIssues);
        issuesTreeProvider.updateFromCodeIssues(localIssues);
        updateStatusBar(localIssues);
        log('No Databricks connection configured — showing local results only');

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
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'CatalystOps',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Checking cluster state...' });
                log(`Checking cluster state (${config.clusterId})...`);
                const running = await ensureClusterRunning(config.host, config.token, config.clusterId);
                if (!running) {
                    log('Cluster not ready — aborting cluster analysis');
                    return undefined;
                }
                log('Cluster is running');

                progress.report({ message: 'Generating analysis script...' });
                const sourceDir = path.dirname(editor.document.uri.fsPath);
                const { script, processedUserCode } = generateClusterScript(code, sourceDir);
                lastProcessedUserCode = processedUserCode;
                log(`Script generated (${script.length} chars)`);

                progress.report({ message: 'Running dry-run analysis on cluster...' });
                log('Submitting script to cluster...');
                return executeCommand(config.host, config.token, config.clusterId, script);
            },
        );

        if (!result) {
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            updateStatusBar(localIssues);
            return;
        }

        if (result.status === 'Error' || result.results?.resultType === 'error') {
            const errorMsg = result.results?.cause || result.results?.data || 'Unknown error';
            logError(`Cluster execution failed: ${errorMsg}`);
            setError(errorMsg.substring(0, 100));
            vscode.window.showErrorMessage(`CatalystOps cluster analysis failed: ${errorMsg}`);

            // Still show local issues
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            return;
        }

        // Parse cluster results
        log('Parsing cluster results...');
        const output = result.results?.data || '';
        lastRawOutput = output;
        const parsed = extractResult(output);

        // Collect execution warnings (partial failures like undefined functions)
        const execErrors = parsed?.errors ?? [];
        const execWarning = execErrors.length > 0
            ? execErrors.map((e: any) => e.error || e.traceback || JSON.stringify(e)).join('; ')
            : '';

        if (execErrors.length > 0) {
            logError(`Execution warnings: ${execWarning}`);
        }

        if (!parsed || parsed.results.length === 0) {
            // No cluster results — show local issues + errors
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            updateStatusBar(localIssues);
            log('No DataFrames found in cluster output');

            if (execWarning) {
                vscode.window.showErrorMessage(`CatalystOps: No DataFrames found. Execution error: ${execWarning}`);
            }
            return;
        }

        // Map cluster results to diagnostics and merge with local issues
        const analysisResults = parsed.results as AnalysisResult[];
        lastAnalysisResult = analysisResults;
        log(`Found ${analysisResults.length} DataFrame(s)`);

        // Parse plan issues and update analysis cache with dollar estimates
        const planIssues = parsePlanFromResults(analysisResults);
        const cluster = analysisResults[0]?.cluster;
        const dbuRate = vscode.workspace.getConfiguration('catalystops')
            .get<number>('cost.dbuRatePerHour');
        updateCache(analysisResults, planIssues, editor.document);

        // Enrich cache entries with dollar estimates
        const lineCosts = getAllLineCosts(editor.document.uri.toString());
        if (lineCosts && cluster) {
            for (const [, entry] of lineCosts) {
                const est = estimateDollarCost(entry.costPoints, cluster, dbuRate);
                entry.dollarEstimate = est.formatted;
            }
        }

        const clusterDiagnostics = mapResultsToDiagnostics(analysisResults, editor.document);
        const allIssues = [...localIssues, ...clusterDiagnostics];

        setCodeIssueDiagnostics(editor.document.uri, allIssues);
        issuesTreeProvider.updateFromAnalysisResults(analysisResults, localIssues);
        updateStatusBar(allIssues);

        const totalIssues = allIssues.length;
        const planCount = clusterDiagnostics.length;
        const dfCount = analysisResults.length;
        log(`Analysis complete: ${totalIssues} total issue(s) (${localIssues.length} local, ${planCount} from ${dfCount} DataFrame(s))`);

        let msg = `CatalystOps: Analysis complete. ${totalIssues} issues found (${localIssues.length} local, ${planCount} from ${dfCount} DataFrames).`;
        if (execWarning) {
            msg += ` Warning: ${execWarning}`;
        }
        vscode.window.showInformationMessage(msg);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(message);
        setError(message.substring(0, 100));
        vscode.window.showErrorMessage(`CatalystOps: ${message}`);

        // Show local issues even on error
        setCodeIssueDiagnostics(editor.document.uri, localIssues);
        issuesTreeProvider.updateFromCodeIssues(localIssues);
    }
}

function updateStatusBar(issues: CodeIssue[]): void {
    const critical = issues.filter(i => i.severity === Severity.CRITICAL).length;
    const warnings = issues.filter(i => i.severity === Severity.WARNING).length;
    const info = issues.filter(i => i.severity === Severity.INFO || i.severity === Severity.SUGGESTION).length;
    setResults(critical, warnings, info);
}
