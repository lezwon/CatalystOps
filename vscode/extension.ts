/**
 * CatalystOps - VS Code Extension for PySpark Optimization
 *
 * Entry point: activate/deactivate
 */

import * as vscode from 'vscode';
import { analyzeCode } from './analysis/codeAnalyzer';
import { validateSchema } from './analysis/schemaValidator';
import { estimateStaticCost } from './analysis/staticCostEstimator';
import { analyzeWriteOps } from './analysis/schemaTracker';
import { createDiagnosticCollection, setCodeIssueDiagnostics, clearDiagnostics } from './providers/diagnosticsProvider';
import { createStatusBar, setIdle, setAnalyzing, setResults, setError } from './views/statusBar';
import { analyzeCost, showGeneratedScript, previewDryRunScript, previewFullDryRunScript, showFullDryRunScript } from './commands/analyzeCost';
import { initOutputChannel, logDebug, logError } from './logger';
import { initTelemetry, sendEvent, maybeShowFeedbackToast, maybeShowDryRunNudge } from './telemetry';
import { analyzeSelection } from './commands/analyzeSelection';
import { showReport } from './commands/showReport';
import { configureConnection } from './commands/configureConnection';
import { createCodeLensProvider } from './providers/codeLensProvider';
import { createHoverProvider, createWriteSchemaHoverProvider } from './providers/hoverProvider';
import { createCodeActionProvider } from './providers/codeActionProvider';
import { IssuesTreeDataProvider } from './views/issuesTreeView';
import { BillingTreeDataProvider } from './views/billingTreeView';
import { ExplainTreeDataProvider, PlanNodeItem } from './views/explainTreeView';
import { showDagWebview, disposeDagWebview } from './views/dagWebview';
import { showBillingDashboard } from './commands/showBillingDashboard';
import { Severity } from './models/types';
import { startMcpServer, stopMcpServer } from './mcp/server';
import { updateMcpSnapshot } from './mcp/mcpState';
import { onCacheUpdated, getCachedResults, getCachedPlanIssues, getDataFrameLineMap } from './analysis/analysisCache';
import { buildPlanTrees } from './analysis/planTreeBuilder';

export function activate(context: vscode.ExtensionContext): void {
    initOutputChannel(context);
    initTelemetry(context);
    sendEvent('extension/activated');

    try {
        const diagnostics = createDiagnosticCollection();
        const statusBar = createStatusBar();

        // Issues tree view
        const issuesTreeProvider = new IssuesTreeDataProvider();
        vscode.window.registerTreeDataProvider('catalystops.issuesTree', issuesTreeProvider);

        // Explain Plan tree view
        const explainTreeProvider = new ExplainTreeDataProvider();
        vscode.window.registerTreeDataProvider('catalystops.explainTree', explainTreeProvider);

        // Refresh explain tree whenever the analysis cache updates (after dry run)
        context.subscriptions.push(
            onCacheUpdated(() => {
                const activeDoc = vscode.window.activeTextEditor?.document;
                const dfMap = activeDoc
                    ? getDataFrameLineMap(activeDoc.uri.toString())
                    : new Map<string, number>();
                const results = getCachedResults();
                const planIssues = getCachedPlanIssues();
                explainTreeProvider.update(results, planIssues, dfMap);
                if (results.length > 0) {
                    sendEvent('explain_plan/updated', {
                        dataframeCount: String(results.length),
                        planIssueCount: String(planIssues.length),
                    });
                }
            }),
        );

        // Billing tree view
        const billingTreeProvider = new BillingTreeDataProvider();
        vscode.window.registerTreeDataProvider('catalystops.billingTree', billingTreeProvider);

        // Register commands
        context.subscriptions.push(
            diagnostics,
            statusBar,
            vscode.commands.registerCommand('catalystops.analyzeCost', () => analyzeCost(context, issuesTreeProvider)),
            vscode.commands.registerCommand('catalystops.analyzeSelection', () => analyzeSelection(context, issuesTreeProvider)),
            vscode.commands.registerCommand('catalystops.showReport', () => showReport(context)),
            vscode.commands.registerCommand('catalystops.configureConnection', () => configureConnection()),
            vscode.commands.registerCommand('catalystops.showGeneratedScript', () => showGeneratedScript()),
            vscode.commands.registerCommand('catalystops.previewDryRunScript', () => previewDryRunScript()),
            vscode.commands.registerCommand('catalystops.previewFullDryRunScript', () => previewFullDryRunScript()),
            vscode.commands.registerCommand('catalystops.showFullDryRunScript', () => showFullDryRunScript()),
            vscode.commands.registerCommand('catalystops.showBillingDashboard',
                () => showBillingDashboard(context, billingTreeProvider)),
            vscode.commands.registerCommand('catalystops.refreshBilling',
                () => showBillingDashboard(context, billingTreeProvider, undefined, undefined, true)),

            // Explain Plan + DAG commands
            vscode.commands.registerCommand('catalystops.showPlanDag', () => {
                const activeDoc = vscode.window.activeTextEditor?.document;
                const dfMap = activeDoc
                    ? getDataFrameLineMap(activeDoc.uri.toString())
                    : new Map<string, number>();
                const nodes = buildPlanTrees(getCachedResults(), getCachedPlanIssues(), dfMap);
                sendEvent('dag/opened', { nodeCount: String(nodes.length) });
                showDagWebview(context, nodes);
            }),

            vscode.commands.registerCommand('catalystops.jumpToLine', (sourceLine: number) => {
                if (typeof sourceLine === 'number') {
                    void vscode.commands.executeCommand('revealLine', {
                        lineNumber: sourceLine,
                        at: 'center',
                    });
                }
            }),

            // Quick fix commands (invoked via inline tree item buttons)
            vscode.commands.registerCommand('catalystops.quickfix.broadcastHint', async (item: unknown) => {
                const node = (item as PlanNodeItem)?.planNode;
                const sourceLine = node?.sourceLine;
                const editor = vscode.window.activeTextEditor;
                if (!editor || sourceLine === undefined) { return; }
                const line = editor.document.lineAt(sourceLine);
                const newText = line.text.replace(/\.join\s*\((\s*\w+)(\s*,)/, '.join(broadcast($1)$2');
                if (newText === line.text) {
                    void vscode.window.showInformationMessage('CatalystOps: No join call found on this line.');
                    return;
                }
                const edit = new vscode.WorkspaceEdit();
                edit.replace(editor.document.uri, line.range, newText);
                await vscode.workspace.applyEdit(edit);
            }),

            vscode.commands.registerCommand('catalystops.quickfix.repartition', async (item: unknown) => {
                const node = (item as PlanNodeItem)?.planNode;
                const sourceLine = node?.sourceLine;
                const editor = vscode.window.activeTextEditor;
                if (!editor || sourceLine === undefined) { return; }
                const line = editor.document.lineAt(sourceLine);
                // Insert .repartition(200) before .join( or .groupBy(
                const newText = line.text.replace(
                    /(\.\s*(?:join|groupBy)\s*\()/,
                    '.repartition(200)$1',
                );
                if (newText === line.text) {
                    void vscode.window.showInformationMessage('CatalystOps: No join/groupBy found on this line.');
                    return;
                }
                const edit = new vscode.WorkspaceEdit();
                edit.replace(editor.document.uri, line.range, newText);
                await vscode.workspace.applyEdit(edit);
            }),

            vscode.commands.registerCommand('catalystops.quickfix.persist', async (item: unknown) => {
                const node = (item as PlanNodeItem)?.planNode;
                const dfName = node?.dataframeName;
                const sourceLine = node?.sourceLine;
                const editor = vscode.window.activeTextEditor;
                if (!editor || !dfName || sourceLine === undefined) { return; }
                // Insert dfName = dfName.persist() on the line after the assignment
                const insertLine = sourceLine + 1;
                const lineEnd = new vscode.Position(insertLine, 0);
                const indent = editor.document.lineAt(sourceLine).text.match(/^(\s*)/)?.[1] ?? '';
                const edit = new vscode.WorkspaceEdit();
                edit.insert(editor.document.uri, lineEnd, `${indent}${dfName} = ${dfName}.persist()\n`);
                await vscode.workspace.applyEdit(edit);
            }),

            vscode.commands.registerCommand('catalystops.quickfix.aqeConfig', async (item: unknown) => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }
                const edit = new vscode.WorkspaceEdit();
                edit.insert(
                    editor.document.uri,
                    new vscode.Position(0, 0),
                    'spark.conf.set("spark.sql.adaptive.enabled", "true")\n',
                );
                await vscode.workspace.applyEdit(edit);
            }),

            vscode.commands.registerCommand('catalystops.quickfix.addJoinCondition', async (item: unknown) => {
                const node = (item as PlanNodeItem)?.planNode;
                const sourceLine = node?.sourceLine;
                const editor = vscode.window.activeTextEditor;
                if (!editor || sourceLine === undefined) { return; }
                const key = await vscode.window.showInputBox({
                    prompt: 'Enter the join key column name',
                    placeHolder: 'e.g. id',
                });
                if (!key) { return; }
                const line = editor.document.lineAt(sourceLine);
                const newText = line.text.replace(
                    /\.crossJoin\s*\((\s*\w+)\s*\)/,
                    `.join($1, "${key}")`,
                );
                if (newText === line.text) {
                    void vscode.window.showInformationMessage('CatalystOps: No crossJoin found on this line.');
                    return;
                }
                const edit = new vscode.WorkspaceEdit();
                edit.replace(editor.document.uri, line.range, newText);
                await vscode.workspace.applyEdit(edit);
            }),

            { dispose: () => { disposeDagWebview(); } },
        );

        const config = vscode.workspace.getConfiguration('catalystops');

        // Start MCP server (in-process, Streamable HTTP on a dynamic port)
        if (config.get<boolean>('mcp.enabled', true)) {
            startMcpServer(context).then(port => {
                logDebug(`MCP server listening on http://127.0.0.1:${port}/mcp`);
                // VS Code 1.99+ MCP auto-discovery via registerMcpServerDefinitionProvider
                if ('lm' in vscode && typeof (vscode.lm as any).registerMcpServerDefinitionProvider === 'function') {
                    const registration = (vscode.lm as any).registerMcpServerDefinitionProvider('catalystops', {
                        provideMcpServerDefinitions: () => [
                            {
                                label: 'CatalystOps',
                                uri: vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`),
                            },
                        ],
                    });
                    context.subscriptions.push(registration);
                }
                // Register stop on deactivate
                context.subscriptions.push({ dispose: () => { void stopMcpServer(); } });
            }).catch(err => {
                logDebug(`MCP server failed to start: ${err instanceof Error ? err.message : String(err)}`);
            });
        }

        // Register providers for Python files
        const pythonSelector: vscode.DocumentSelector = { language: 'python', scheme: 'file' };
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(pythonSelector, createCodeLensProvider()),
            vscode.languages.registerHoverProvider(pythonSelector, createHoverProvider()),
            vscode.languages.registerHoverProvider(pythonSelector, createWriteSchemaHoverProvider()),
            vscode.languages.registerCodeActionsProvider(pythonSelector, createCodeActionProvider(), {
                providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
            }),
        );

        // Run local analysis on active editor
        if (config.get<boolean>('analysis.enableLocalCodeAnalysis', true)) {
            // Analyze on open and change
            if (vscode.window.activeTextEditor?.document.languageId === 'python') {
                runLocalAnalysis(vscode.window.activeTextEditor.document, issuesTreeProvider);
            }

            let debounceTimer: ReturnType<typeof setTimeout> | undefined;

            context.subscriptions.push(
                vscode.window.onDidChangeActiveTextEditor(editor => {
                    if (editor?.document.languageId === 'python') {
                        runLocalAnalysis(editor.document, issuesTreeProvider);
                        void maybeShowFeedbackToast();
                    }
                }),
                vscode.workspace.onDidChangeTextDocument(event => {
                    if (event.document.languageId === 'python' &&
                        event.document === vscode.window.activeTextEditor?.document) {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(() => {
                            runLocalAnalysis(event.document, issuesTreeProvider);
                        }, 500);
                    }
                }),
                vscode.workspace.onDidCloseTextDocument(doc => {
                    clearDiagnostics(doc.uri);
                }),
            );

            // Auto-analyze (local only) on save if configured.
            // Note: the full dry-run (Databricks execution) must always be triggered manually.
            if (config.get<boolean>('analysis.autoAnalyzeOnSave', false)) {
                context.subscriptions.push(
                    vscode.workspace.onDidSaveTextDocument(doc => {
                        if (doc.languageId === 'python') {
                            runLocalAnalysis(doc, issuesTreeProvider);
                        }
                    }),
                );
            }
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendEvent('extension/activation_failed', { error: message });
        throw err;
    }
}

function runLocalAnalysis(document: vscode.TextDocument, issuesTreeProvider: IssuesTreeDataProvider): void {
    try {
        const code = document.getText();
        const cfg = vscode.workspace.getConfiguration('catalystops');
        const allIssues = [...analyzeCode(code, {
            enableRepeatedScanDetection: cfg.get<boolean>('analysis.enableRepeatedScanDetection', false),
        }), ...validateSchema(code)];

        // When a schema-aware _002 issue fires on a line, suppress the generic _001
        // warning for the same line to avoid duplicate diagnostics.
        const schemaAwareUnionLines = new Set(
            allIssues
                .filter(i => /CODE_UNION_002/.test(i.id))
                .map(i => i.line),
        );
        const dedupSeen = new Set<string>();
        const issues = allIssues.filter(i => {
            // Suppress generic CODE_UNION_001 when a schema-aware CODE_UNION_002 fired on the same line
            if (i.id === 'CODE_UNION_001' && schemaAwareUnionLines.has(i.line)) {
                return false;
            }
            // Deduplicate identical (id, line) pairs to prevent double-reporting
            const key = `${i.id}:${i.line}`;
            if (dedupSeen.has(key)) { return false; }
            dedupSeen.add(key);
            return true;
        });

        const costEstimate = estimateStaticCost(code);
        issuesTreeProvider.updateCostEstimate(costEstimate);

        const writeOps = analyzeWriteOps(code);
        issuesTreeProvider.updateWriteOperations(writeOps);

        setCodeIssueDiagnostics(document.uri, issues);
        issuesTreeProvider.updateFromCodeIssues(issues);
        updateMcpSnapshot({ filePath: document.fileName, issues, updatedAt: new Date() });

        const critical = issues.filter(i => i.severity === Severity.CRITICAL).length;
        const warnings = issues.filter(i => i.severity === Severity.WARNING).length;
        const info = issues.filter(i => i.severity === Severity.INFO || i.severity === Severity.SUGGESTION).length;
        setResults(critical, warnings, info);

        void maybeShowDryRunNudge(issues.length);
        logDebug(`Local analysis: ${issues.length} issue(s) in ${document.fileName}`);
        sendEvent('local_analysis/complete', {
            issueCount: String(issues.length),
            critical: String(critical),
            warnings: String(warnings),
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Local analysis failed: ${message}`);
        sendEvent('local_analysis/failed', { error: message.substring(0, 200) });
    }
}

export function deactivate(): void {
    // Cleanup handled by disposables
}
