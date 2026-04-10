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
import { initTelemetry, sendEvent, maybeShowFeedbackToast, maybeShowDryRunNudge, incrementSessionCount, trackWalkthroughStart, trackWalkthroughStep } from './telemetry';
import { analyzeSelection } from './commands/analyzeSelection';
import { showReport } from './commands/showReport';
import { configureConnection } from './commands/configureConnection';
import { createCodeLensProvider } from './providers/codeLensProvider';
import { createHoverProvider, createWriteSchemaHoverProvider } from './providers/hoverProvider';
import { createCodeActionProvider } from './providers/codeActionProvider';
import { IssuesTreeDataProvider } from './views/issuesTreeView';
import { BillingTreeDataProvider } from './views/billingTreeView';
import { JobsTreeDataProvider, JobItem } from './views/jobsTreeView';
import { refreshJobsList, analyzeJobRun as analyzeJobRunCmd } from './commands/analyzeJobRun';
import { refreshClustersList, connectClusterSsh, startClusterCommand, stopClusterCommand, clearSshAlias } from './commands/connectSsh';
import { ClustersTreeDataProvider, ClusterItem } from './views/clustersTreeView';
import { ExplainTreeDataProvider, PlanNodeItem } from './views/explainTreeView';
import { showDagWebview, disposeDagWebview } from './views/dagWebview';
import { showBillingDashboard } from './commands/showBillingDashboard';
import { Severity } from './models/types';
import { startMcpServer, stopMcpServer } from './mcp/server';
import { updateMcpSnapshot } from './mcp/mcpState';
import { onCacheUpdated, getCachedResults, getCachedPlanIssues, getDataFrameLineMap } from './analysis/analysisCache';
import { buildPlanTrees } from './analysis/planTreeBuilder';
import { getConnectionConfig } from './config/settings';
import { setExtensionContext } from './extensionContext';

export function activate(context: vscode.ExtensionContext): void {
    setExtensionContext(context);
    initOutputChannel(context);
    initTelemetry(context);
    sendEvent('extension/activated');
    void incrementSessionCount();
    trackWalkthroughStart();

    try {
        const diagnostics = createDiagnosticCollection();
        const statusBar = createStatusBar();

        // Issues tree view
        const issuesTreeProvider = new IssuesTreeDataProvider();
        const issuesTreeView = vscode.window.createTreeView('catalystops.issuesTree', { treeDataProvider: issuesTreeProvider });
        context.subscriptions.push(issuesTreeView);
        issuesTreeView.onDidChangeVisibility(e => {
            if (e.visible) { trackWalkthroughStep('local-analysis'); }
        }, undefined, context.subscriptions);

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

        // Set VS Code context for Databricks-dependent views
        function setDatabricksContext(): void {
            const configured = !!getConnectionConfig();
            void vscode.commands.executeCommand('setContext', 'catalystops.databricksConfigured', configured);
        }
        setDatabricksContext();

        // Billing tree view
        const billingTreeProvider = new BillingTreeDataProvider();
        vscode.window.registerTreeDataProvider('catalystops.billingTree', billingTreeProvider);

        // Jobs tree view (configurable)
        const jobsTreeProvider = new JobsTreeDataProvider();
        const jobsTreeView = vscode.window.createTreeView('catalystops.jobsTree', { treeDataProvider: jobsTreeProvider });
        context.subscriptions.push(jobsTreeView);
        if (getConnectionConfig() && vscode.workspace.getConfiguration('catalystops').get<boolean>('jobs.enabled', true)) {
            void refreshJobsList(jobsTreeProvider);
        } else if (!getConnectionConfig()) {
            // Panels will be hidden via when clause; nothing to do
        } else {
            jobsTreeProvider.setError('Jobs panel disabled. Enable "catalystops.jobs.enabled" in settings.');
        }

        // Double-click detection: the TreeItem command fires on every click.
        // Two calls for the same item within 400 ms = double-click → trigger analysis.
        let lastClickedRunId: number | undefined;
        let lastClickedJobName: string | undefined;
        let lastClickTime = 0;

        // Clusters tree view
        const clustersTreeProvider = new ClustersTreeDataProvider();
        vscode.window.registerTreeDataProvider('catalystops.clustersTree', clustersTreeProvider);
        if (getConnectionConfig()) {
            void refreshClustersList(clustersTreeProvider);
        }

        // Register commands
        context.subscriptions.push(
            diagnostics,
            statusBar,
            vscode.commands.registerCommand('catalystops.analyzeCost', () => { trackWalkthroughStep('dry-run'); return analyzeCost(context, issuesTreeProvider); }),
            vscode.commands.registerCommand('catalystops.analyzeSelection', () => analyzeSelection(context, issuesTreeProvider)),
            vscode.commands.registerCommand('catalystops.showReport', () => showReport(context)),
            vscode.commands.registerCommand('catalystops.configureConnection', async () => { trackWalkthroughStep('connect'); await configureConnection(); setDatabricksContext(); }),
            vscode.commands.registerCommand('catalystops.showGeneratedScript', () => showGeneratedScript()),
            vscode.commands.registerCommand('catalystops.previewDryRunScript', () => previewDryRunScript()),
            vscode.commands.registerCommand('catalystops.previewFullDryRunScript', () => previewFullDryRunScript()),
            vscode.commands.registerCommand('catalystops.showFullDryRunScript', () => showFullDryRunScript()),
            vscode.commands.registerCommand('catalystops.showBillingDashboard',
                () => { trackWalkthroughStep('billing'); return showBillingDashboard(context, billingTreeProvider); }),
            vscode.commands.registerCommand('catalystops.refreshBilling',
                () => showBillingDashboard(context, billingTreeProvider, undefined, undefined, true)),
            vscode.commands.registerCommand('catalystops.refreshJobs',
                () => {
                    if (vscode.workspace.getConfiguration('catalystops').get<boolean>('jobs.enabled', true)) {
                        void refreshJobsList(jobsTreeProvider);
                    }
                }),
            vscode.commands.registerCommand('catalystops.analyzeJobRun',
                (runId: number, jobName: string) => { trackWalkthroughStep('jobs'); return analyzeJobRunCmd(context, issuesTreeProvider, runId, jobName); }),
            vscode.commands.registerCommand('catalystops.jobItemClicked',
                (runId: number, jobName: string) => {
                    const now = Date.now();
                    if (runId === lastClickedRunId && jobName === lastClickedJobName && now - lastClickTime < 400) {
                        lastClickedRunId = undefined;
                        void analyzeJobRunCmd(context, issuesTreeProvider, runId, jobName);
                    } else {
                        lastClickedRunId = runId;
                        lastClickedJobName = jobName;
                        lastClickTime = now;
                    }
                }),
            vscode.commands.registerCommand('catalystops.refreshClusters',
                () => void refreshClustersList(clustersTreeProvider)),
            vscode.commands.registerCommand('catalystops.connectClusterSsh',
                (item: unknown) => {
                    const cluster = item instanceof ClusterItem ? item.cluster : undefined;
                    if (!cluster) { return; }
                    void connectClusterSsh(cluster, context, clustersTreeProvider);
                }),
            vscode.commands.registerCommand('catalystops.startCluster',
                (item: unknown) => {
                    const cluster = item instanceof ClusterItem ? item.cluster : undefined;
                    if (!cluster) { return; }
                    void startClusterCommand(cluster, clustersTreeProvider);
                }),
            vscode.commands.registerCommand('catalystops.stopCluster',
                (item: unknown) => {
                    const cluster = item instanceof ClusterItem ? item.cluster : undefined;
                    if (!cluster) { return; }
                    void stopClusterCommand(cluster, clustersTreeProvider);
                }),
            vscode.commands.registerCommand('catalystops.clearSshAlias',
                (item: unknown) => {
                    const cluster = item instanceof ClusterItem ? item.cluster : undefined;
                    if (!cluster) { return; }
                    void clearSshAlias(cluster, context);
                }),

            // Explain Plan + DAG commands
            vscode.commands.registerCommand('catalystops.showPlanDag', () => {
                trackWalkthroughStep('explain-plan');
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
                if (sourceLine < 0 || sourceLine >= editor.document.lineCount) { return; }
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
                if (sourceLine < 0 || sourceLine >= editor.document.lineCount) { return; }
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
                if (sourceLine < 0 || sourceLine >= editor.document.lineCount) { return; }
                // Insert dfName = dfName.persist() on the line after the assignment
                const insertLine = Math.min(sourceLine + 1, editor.document.lineCount);
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
                if (sourceLine < 0 || sourceLine >= editor.document.lineCount) { return; }
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

        // Re-evaluate Databricks context when relevant settings change
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('catalystops.databricks') ||
                    e.affectsConfiguration('catalystops.connection')) {
                    setDatabricksContext();
                }
            }),
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
            // Analyze on open and change — Python files
            if (vscode.window.activeTextEditor?.document.languageId === 'python') {
                runLocalAnalysis(vscode.window.activeTextEditor.document, issuesTreeProvider);
            }

            // Analyze active notebook on startup
            if (vscode.window.activeNotebookEditor?.notebook) {
                runNotebookAnalysis(vscode.window.activeNotebookEditor.notebook, issuesTreeProvider);
            }

            let debounceTimer: ReturnType<typeof setTimeout> | undefined;
            let nbDebounceTimer: ReturnType<typeof setTimeout> | undefined;

            context.subscriptions.push(
                vscode.window.onDidChangeActiveTextEditor(editor => {
                    if (editor?.document.languageId === 'python') {
                        runLocalAnalysis(editor.document, issuesTreeProvider);
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

                // Notebook events
                vscode.window.onDidChangeActiveNotebookEditor(editor => {
                    if (editor?.notebook) {
                        runNotebookAnalysis(editor.notebook, issuesTreeProvider);
                    }
                }),
                vscode.workspace.onDidChangeNotebookDocument(event => {
                    clearTimeout(nbDebounceTimer);
                    nbDebounceTimer = setTimeout(() => {
                        runNotebookAnalysis(event.notebook, issuesTreeProvider);
                    }, 500);
                }),
                vscode.workspace.onDidCloseNotebookDocument(notebook => {
                    for (const cell of notebook.getCells()) {
                        clearDiagnostics(cell.document.uri);
                    }
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
                    vscode.workspace.onDidSaveNotebookDocument(notebook => {
                        runNotebookAnalysis(notebook, issuesTreeProvider);
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
        void maybeShowFeedbackToast();
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

function runNotebookAnalysis(notebook: vscode.NotebookDocument, issuesTreeProvider: IssuesTreeDataProvider): void {
    try {
        // Collect Python code cells with their starting line offsets in the concatenated source
        const pythonCells = notebook.getCells().filter(
            cell => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'python',
        );
        if (pythonCells.length === 0) { return; }

        type CellOffset = { cell: vscode.NotebookCell; startLine: number; lineCount: number };
        const cellOffsets: CellOffset[] = [];
        const allLines: string[] = [];

        for (const cell of pythonCells) {
            // Strip IPython magic lines (%magic, %%magic, !shell) — they're not valid Python
            // but preserve line count so issue line numbers stay accurate
            const lines = cell.document.getText().split('\n').map(l =>
                /^\s*(%%?[\w.]+|!)/.test(l) ? '' : l,
            );
            cellOffsets.push({ cell, startLine: allLines.length, lineCount: lines.length });
            allLines.push(...lines);
        }

        const fullCode = allLines.join('\n');
        const cfg = vscode.workspace.getConfiguration('catalystops');
        const rawIssues = [...analyzeCode(fullCode, {
            enableRepeatedScanDetection: cfg.get<boolean>('analysis.enableRepeatedScanDetection', false),
        }), ...validateSchema(fullCode)];

        // Same dedup logic as runLocalAnalysis
        const schemaAwareUnionLines = new Set(
            rawIssues.filter(i => /CODE_UNION_002/.test(i.id)).map(i => i.line),
        );
        const dedupSeen = new Set<string>();
        const issues = rawIssues.filter(i => {
            if (i.id === 'CODE_UNION_001' && schemaAwareUnionLines.has(i.line)) { return false; }
            const key = `${i.id}:${i.line}`;
            if (dedupSeen.has(key)) { return false; }
            dedupSeen.add(key);
            return true;
        });

        // Clear existing diagnostics on all Python cells
        for (const { cell } of cellOffsets) {
            clearDiagnostics(cell.document.uri);
        }

        // Bucket issues by cell and remap to cell-local line numbers
        const issuesByCell = new Map<number, typeof issues>();
        for (const issue of issues) {
            for (let i = 0; i < cellOffsets.length; i++) {
                const { startLine, lineCount } = cellOffsets[i];
                if (issue.line >= startLine && issue.line < startLine + lineCount) {
                    if (!issuesByCell.has(i)) { issuesByCell.set(i, []); }
                    issuesByCell.get(i)!.push({
                        ...issue,
                        line: issue.line - startLine,
                        endLine: Math.max(0, (issue.endLine ?? issue.line) - startLine),
                    });
                    break;
                }
            }
        }

        for (const [i, cellIssues] of issuesByCell) {
            setCodeIssueDiagnostics(cellOffsets[i].cell.document.uri, cellIssues);
        }

        issuesTreeProvider.updateFromCodeIssues(issues);
        updateMcpSnapshot({ filePath: notebook.uri.fsPath, issues, updatedAt: new Date() });

        const critical = issues.filter(i => i.severity === Severity.CRITICAL).length;
        const warnings = issues.filter(i => i.severity === Severity.WARNING).length;
        const info = issues.filter(i => i.severity === Severity.INFO || i.severity === Severity.SUGGESTION).length;
        setResults(critical, warnings, info);

        logDebug(`Notebook analysis: ${issues.length} issue(s) across ${pythonCells.length} cell(s) in ${notebook.uri.fsPath}`);
        sendEvent('local_analysis/notebook_complete', {
            issueCount: String(issues.length),
            cellCount: String(pythonCells.length),
            critical: String(critical),
            warnings: String(warnings),
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Notebook analysis failed: ${message}`);
        sendEvent('local_analysis/notebook_failed', { error: message.substring(0, 200) });
    }
}

export function deactivate(): void {
    // Cleanup handled by disposables
}
