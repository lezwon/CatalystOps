/**
 * Analyze selected code only
 */

import * as vscode from 'vscode';
import { analyzeCode } from '../analysis/codeAnalyzer';
import { setCodeIssueDiagnostics } from '../providers/diagnosticsProvider';
import { setResults } from '../views/statusBar';
import { IssuesTreeDataProvider } from '../views/issuesTreeView';
import { Severity } from '../models/types';
import { sendEvent } from '../telemetry';

export async function analyzeSelection(
    context: vscode.ExtensionContext,
    issuesTreeProvider: IssuesTreeDataProvider,
): Promise<void> {
    sendEvent('command/analyze_selection');

    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('CatalystOps: No active editor.');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showWarningMessage('CatalystOps: Select some PySpark code to analyze.');
            return;
        }

        const selectedCode = editor.document.getText(selection);
        const issues = analyzeCode(selectedCode);

        // Offset line numbers to match document position
        const offsetIssues = issues.map(issue => ({
            ...issue,
            line: issue.line + selection.start.line,
            endLine: (issue.endLine ?? issue.line) + selection.start.line,
        }));

        setCodeIssueDiagnostics(editor.document.uri, offsetIssues);
        issuesTreeProvider.updateFromCodeIssues(offsetIssues);

        const critical = offsetIssues.filter(i => i.severity === Severity.CRITICAL).length;
        const warnings = offsetIssues.filter(i => i.severity === Severity.WARNING).length;
        const info = offsetIssues.filter(i => i.severity === Severity.INFO || i.severity === Severity.SUGGESTION).length;
        setResults(critical, warnings, info);

        sendEvent('analyze_selection/complete', {
            issueCount: String(offsetIssues.length),
            criticalCount: String(critical),
            warningCount: String(warnings),
            infoCount: String(info),
        });

        vscode.window.showInformationMessage(
            `CatalystOps: Found ${offsetIssues.length} issues in selection.`,
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendEvent('command/analyze_selection_failed', { error: message.substring(0, 200) });
        vscode.window.showErrorMessage(`CatalystOps: ${message}`);
    }
}
