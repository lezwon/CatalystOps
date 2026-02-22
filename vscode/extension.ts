/**
 * CatalystOps - VS Code Extension for PySpark Optimization
 *
 * Entry point: activate/deactivate
 */

import * as vscode from 'vscode';
import { analyzeCode } from './analysis/codeAnalyzer';
import { createDiagnosticCollection, setCodeIssueDiagnostics, clearDiagnostics } from './providers/diagnosticsProvider';
import { createStatusBar, setIdle, setAnalyzing, setResults, setError } from './views/statusBar';
import { analyzeCost, showGeneratedScript } from './commands/analyzeCost';
import { initOutputChannel } from './logger';
import { initTelemetry, sendEvent } from './telemetry';
import { analyzeSelection } from './commands/analyzeSelection';
import { showReport } from './commands/showReport';
import { configureConnection } from './commands/configureConnection';
import { createCodeLensProvider } from './providers/codeLensProvider';
import { createHoverProvider } from './providers/hoverProvider';
import { createCodeActionProvider } from './providers/codeActionProvider';
import { IssuesTreeDataProvider } from './views/issuesTreeView';
import { Severity } from './models/types';

export function activate(context: vscode.ExtensionContext): void {
    initOutputChannel(context);
    initTelemetry(context);
    sendEvent('extension/activated');

    const diagnostics = createDiagnosticCollection();
    const statusBar = createStatusBar();

    // Issues tree view
    const issuesTreeProvider = new IssuesTreeDataProvider();
    vscode.window.registerTreeDataProvider('catalystops.issuesTree', issuesTreeProvider);

    // Register commands
    context.subscriptions.push(
        diagnostics,
        statusBar,
        vscode.commands.registerCommand('catalystops.analyzeCost', () => analyzeCost(context, issuesTreeProvider)),
        vscode.commands.registerCommand('catalystops.analyzeSelection', () => analyzeSelection(context, issuesTreeProvider)),
        vscode.commands.registerCommand('catalystops.showReport', () => showReport(context)),
        vscode.commands.registerCommand('catalystops.configureConnection', () => configureConnection()),
        vscode.commands.registerCommand('catalystops.showGeneratedScript', () => showGeneratedScript()),
    );

    // Register providers for Python files
    const pythonSelector: vscode.DocumentSelector = { language: 'python', scheme: 'file' };
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(pythonSelector, createCodeLensProvider()),
        vscode.languages.registerHoverProvider(pythonSelector, createHoverProvider()),
        vscode.languages.registerCodeActionsProvider(pythonSelector, createCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
        }),
    );

    // Run local analysis on active editor
    const config = vscode.workspace.getConfiguration('catalystops');
    if (config.get<boolean>('analysis.enableLocalCodeAnalysis', true)) {
        // Analyze on open and change
        if (vscode.window.activeTextEditor?.document.languageId === 'python') {
            runLocalAnalysis(vscode.window.activeTextEditor.document, issuesTreeProvider);
        }

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor?.document.languageId === 'python') {
                    runLocalAnalysis(editor.document, issuesTreeProvider);
                }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.languageId === 'python' &&
                    event.document === vscode.window.activeTextEditor?.document) {
                    runLocalAnalysis(event.document, issuesTreeProvider);
                }
            }),
            vscode.workspace.onDidCloseTextDocument(doc => {
                clearDiagnostics(doc.uri);
            }),
        );

        // Auto-analyze on save if configured
        if (config.get<boolean>('analysis.autoAnalyzeOnSave', false)) {
            context.subscriptions.push(
                vscode.workspace.onDidSaveTextDocument(doc => {
                    if (doc.languageId === 'python') {
                        analyzeCost(context, issuesTreeProvider);
                    }
                }),
            );
        }
    }
}

function runLocalAnalysis(document: vscode.TextDocument, issuesTreeProvider: IssuesTreeDataProvider): void {
    const code = document.getText();
    const issues = analyzeCode(code);

    setCodeIssueDiagnostics(document.uri, issues);
    issuesTreeProvider.updateFromCodeIssues(issues);

    const critical = issues.filter(i => i.severity === Severity.CRITICAL).length;
    const warnings = issues.filter(i => i.severity === Severity.WARNING).length;
    const info = issues.filter(i => i.severity === Severity.INFO || i.severity === Severity.SUGGESTION).length;
    setResults(critical, warnings, info);
}

export function deactivate(): void {
    // Cleanup handled by disposables
}
