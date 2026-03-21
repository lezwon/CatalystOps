/**
 * Diagnostics provider - manages VS Code DiagnosticCollection
 */

import * as vscode from 'vscode';
import { CodeIssue, Severity } from '../models/types';
import { DIAGNOSTIC_SOURCE } from '../models/constants';

let diagnosticCollection: vscode.DiagnosticCollection;

export function createDiagnosticCollection(): vscode.DiagnosticCollection {
    diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
    return diagnosticCollection;
}

export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    return diagnosticCollection;
}

/**
 * Convert CodeIssues to VS Code Diagnostics and set them on the document.
 */
export function setCodeIssueDiagnostics(uri: vscode.Uri, issues: CodeIssue[]): void {
    const diagnostics = issues.map(issue => {
        const startLine = Math.max(0, issue.line);
        const startCol  = Math.max(0, issue.column);
        const endLine   = Math.max(startLine, issue.endLine ?? startLine);
        const endCol    = Math.max(0, issue.endColumn ?? startCol + 1);
        const range = new vscode.Range(startLine, startCol, endLine, endCol);

        const diagnostic = new vscode.Diagnostic(
            range,
            issue.title,
            severityToVscode(issue.severity),
        );

        diagnostic.source = DIAGNOSTIC_SOURCE;

        return diagnostic;
    });

    diagnosticCollection.set(uri, diagnostics);
}

/**
 * Clear diagnostics for a specific document.
 */
export function clearDiagnostics(uri: vscode.Uri): void {
    diagnosticCollection.delete(uri);
}

/**
 * Clear all diagnostics.
 */
export function clearAllDiagnostics(): void {
    diagnosticCollection.clear();
}

function severityToVscode(severity: Severity): vscode.DiagnosticSeverity {
    switch (severity) {
        case Severity.CRITICAL: return vscode.DiagnosticSeverity.Error;
        case Severity.WARNING: return vscode.DiagnosticSeverity.Warning;
        case Severity.INFO: return vscode.DiagnosticSeverity.Information;
        case Severity.SUGGESTION: return vscode.DiagnosticSeverity.Hint;
    }
}
