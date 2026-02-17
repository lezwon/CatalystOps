/**
 * Main "Analyze Cost" command - performs full dry run analysis
 */

import * as vscode from 'vscode';
import { getConnectionConfig, shouldInstallSparkOptimizer } from '../config/settings';
import { ensureClusterRunning } from '../databricks/clusterManager';
import { executeCommand } from '../databricks/commandExecution';
import { generateClusterScript, extractResult } from '../analysis/clusterScript';
import { analyzeCode } from '../analysis/codeAnalyzer';
import { parsePlanFromResults } from '../analysis/planParser';
import { mapResultsToDiagnostics } from '../analysis/resultMapper';
import { setCodeIssueDiagnostics } from '../providers/diagnosticsProvider';
import { setAnalyzing, setResults, setError, setIdle } from '../views/statusBar';
import { IssuesTreeDataProvider } from '../views/issuesTreeView';
import { AnalysisResult, CodeIssue, Severity } from '../models/types';

/** Store the last analysis result for report generation */
let lastAnalysisResult: AnalysisResult[] | undefined;
let lastRawOutput: string | undefined;

export function getLastAnalysisResult(): AnalysisResult[] | undefined {
    return lastAnalysisResult;
}

export function getLastRawOutput(): string | undefined {
    return lastRawOutput;
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

    // Always run local analysis first (instant)
    const localIssues = analyzeCode(code);

    // Try cluster analysis
    const config = getConnectionConfig();
    if (!config) {
        // No cluster config — just show local results
        setCodeIssueDiagnostics(editor.document.uri, localIssues);
        issuesTreeProvider.updateFromCodeIssues(localIssues);
        updateStatusBar(localIssues);

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
        // Check cluster is running
        const running = await ensureClusterRunning(config.host, config.token, config.clusterId);
        if (!running) {
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            updateStatusBar(localIssues);
            return;
        }

        // Generate and execute cluster script
        const script = generateClusterScript(code, shouldInstallSparkOptimizer());
        const result = await executeCommand(config.host, config.token, config.clusterId, script);

        if (result.status === 'Error' || result.results?.resultType === 'error') {
            const errorMsg = result.results?.cause || 'Unknown error';
            setError(errorMsg.substring(0, 100));
            vscode.window.showErrorMessage(`CatalystOps cluster analysis failed: ${errorMsg.substring(0, 200)}`);

            // Still show local issues
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            return;
        }

        // Parse cluster results
        const output = result.results?.data || '';
        lastRawOutput = output;
        const parsed = extractResult(output);

        if (!parsed || parsed.results.length === 0) {
            // No cluster results, show local issues only
            setCodeIssueDiagnostics(editor.document.uri, localIssues);
            issuesTreeProvider.updateFromCodeIssues(localIssues);
            updateStatusBar(localIssues);

            if (parsed?.errors?.length) {
                vscode.window.showWarningMessage(
                    `CatalystOps: Cluster analysis had errors. Showing local analysis only.`,
                );
            }
            return;
        }

        // Map cluster results to diagnostics and merge with local issues
        const analysisResults = parsed.results as AnalysisResult[];
        lastAnalysisResult = analysisResults;

        const clusterDiagnostics = mapResultsToDiagnostics(analysisResults, editor.document);
        const allIssues = [...localIssues, ...clusterDiagnostics];

        setCodeIssueDiagnostics(editor.document.uri, allIssues);
        issuesTreeProvider.updateFromAnalysisResults(analysisResults, localIssues);
        updateStatusBar(allIssues);

        const totalIssues = allIssues.length;
        vscode.window.showInformationMessage(
            `CatalystOps: Analysis complete. ${totalIssues} issues found (${localIssues.length} local, ${clusterDiagnostics.length} from plan).`,
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
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
