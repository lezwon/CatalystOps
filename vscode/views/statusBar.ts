/**
 * Status bar item for CatalystOps
 */

import * as vscode from 'vscode';

let statusBarItem: vscode.StatusBarItem;

export function createStatusBar(): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'catalystops.analyzeCost';
    setIdle();
    statusBarItem.show();
    return statusBarItem;
}

export function setIdle(): void {
    statusBarItem.text = '$(sparkle) CatalystOps';
    statusBarItem.tooltip = 'Click to analyze PySpark code (Ctrl+Shift+K)';
    statusBarItem.backgroundColor = undefined;
}

export function setAnalyzing(): void {
    statusBarItem.text = '$(loading~spin) Analyzing...';
    statusBarItem.tooltip = 'CatalystOps: Running analysis...';
}

export function setResults(critical: number, warnings: number, info: number): void {
    const total = critical + warnings + info;
    if (total === 0) {
        statusBarItem.text = '$(check) CatalystOps: No issues';
        statusBarItem.tooltip = 'No optimization issues detected';
        statusBarItem.backgroundColor = undefined;
    } else {
        const parts: string[] = [];
        if (critical > 0) { parts.push(`${critical} critical`); }
        if (warnings > 0) { parts.push(`${warnings} warn`); }
        if (info > 0) { parts.push(`${info} info`); }
        statusBarItem.text = `$(warning) CatalystOps: ${parts.join(', ')}`;
        statusBarItem.tooltip = `CatalystOps: ${total} issues found`;
        if (critical > 0) {
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (warnings > 0) {
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBarItem.backgroundColor = undefined;
        }
    }
}

export function setError(message: string): void {
    statusBarItem.text = '$(error) CatalystOps: Error';
    statusBarItem.tooltip = `CatalystOps error: ${message}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
}

export function getStatusBarItem(): vscode.StatusBarItem {
    return statusBarItem;
}
