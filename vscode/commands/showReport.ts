/**
 * Show Report command - opens HTML report in webview
 */

import * as vscode from 'vscode';
import { getLastAnalysisResult } from './analyzeCost';
import { showReportWebview } from '../views/reportWebview';

export async function showReport(context: vscode.ExtensionContext): Promise<void> {
    const results = getLastAnalysisResult();

    if (!results || results.length === 0) {
        const choice = await vscode.window.showInformationMessage(
            'CatalystOps: No analysis results available. Run analysis first?',
            'Run Analysis',
            'Cancel',
        );

        if (choice === 'Run Analysis') {
            await vscode.commands.executeCommand('catalystops.analyzeCost');
            // Try again after analysis
            const newResults = getLastAnalysisResult();
            if (newResults && newResults.length > 0) {
                showReportWebview(context, newResults);
            }
        }
        return;
    }

    showReportWebview(context, results);
}
