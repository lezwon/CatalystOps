/**
 * Issues Tree View - Sidebar tree with issues grouped by severity
 */

import * as vscode from 'vscode';
import { CodeIssue, Severity, AnalysisResult, Issue } from '../models/types';
import { SEVERITY_PRIORITY } from '../models/types';
import { StaticCostEstimate } from '../analysis/staticCostEstimator';
import { WriteOperation } from '../analysis/schemaTracker';

export type ProgressStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface ProgressStep {
    label: string;
    status: ProgressStepStatus;
    detail?: string;
}

type TreeItem = ProgressGroupItem | ProgressStepItem | SeverityGroupItem | IssueItem | CostEstimateGroupItem | CostEstimateItem | OutputGroupItem | WriteOperationItem | WriteColumnItem;

export class IssuesTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private issues: CodeIssue[] = [];
    private clusterIssues: Issue[] = [];
    private progressSteps: ProgressStep[] = [];
    private costEstimate: StaticCostEstimate | null = null;
    private writeOps: WriteOperation[] = [];

    setProgress(steps: ProgressStep[]): void {
        this.progressSteps = [...steps];
        this._onDidChangeTreeData.fire(undefined);
    }

    clearProgress(): void {
        this.progressSteps = [];
        this._onDidChangeTreeData.fire(undefined);
    }

    updateCostEstimate(estimate: StaticCostEstimate | null): void {
        this.costEstimate = estimate;
        this._onDidChangeTreeData.fire(undefined);
    }

    updateWriteOperations(ops: WriteOperation[]): void {
        this.writeOps = ops;
        this._onDidChangeTreeData.fire(undefined);
    }

    updateFromCodeIssues(issues: CodeIssue[]): void {
        this.issues = issues;
        this._onDidChangeTreeData.fire(undefined);
    }

    updateFromAnalysisResults(results: AnalysisResult[], localIssues: CodeIssue[]): void {
        this.issues = localIssues;
        this.clusterIssues = results.flatMap(r => r.issues);
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): TreeItem[] {
        if (!element) {
            const items: TreeItem[] = [];
            if (this.costEstimate !== null) {
                items.push(new CostEstimateGroupItem(this.costEstimate));
            }
            if (this.writeOps.length > 0) {
                items.push(new OutputGroupItem(this.writeOps));
            }
            if (this.progressSteps.length > 0) {
                items.push(new ProgressGroupItem(this.progressSteps));
            }
            items.push(...this.getSeverityGroups());
            return items;
        }

        if (element instanceof CostEstimateGroupItem) {
            return element.children;
        }

        if (element instanceof OutputGroupItem) {
            return element.children;
        }

        if (element instanceof WriteOperationItem) {
            return element.children;
        }

        if (element instanceof ProgressGroupItem) {
            return element.children;
        }

        if (element instanceof SeverityGroupItem) {
            return element.children;
        }

        return [];
    }

    private getSeverityGroups(): SeverityGroupItem[] {
        const allIssues = [...this.issues, ...this.clusterIssues];
        if (allIssues.length === 0) { return []; }

        const groups = new Map<Severity, (CodeIssue | Issue)[]>();
        for (const issue of allIssues) {
            const severity = issue.severity as Severity;
            if (!groups.has(severity)) { groups.set(severity, []); }
            groups.get(severity)!.push(issue);
        }

        return Array.from(groups.entries())
            .sort(([a], [b]) => SEVERITY_PRIORITY[a] - SEVERITY_PRIORITY[b])
            .map(([severity, issues]) => new SeverityGroupItem(severity, issues));
    }
}

class CostEstimateGroupItem extends vscode.TreeItem {
    children: CostEstimateItem[];

    constructor(estimate: StaticCostEstimate) {
        super(
            `Estimated cost: ${estimate.formattedCost}`,
            vscode.TreeItemCollapsibleState.Collapsed,
        );
        this.iconPath = new vscode.ThemeIcon('circuit-board');
        const { nodes, cores, memoryGB, ratePerHour } = estimate.computeSpec;
        this.children = [
            new CostEstimateItem(`Total data: ${estimate.totalDataGB.toFixed(1)} GB`),
            new CostEstimateItem(`Cluster: ${nodes} nodes × ${cores} cores, ${memoryGB} GB/node`),
            new CostEstimateItem(`Rate: $${ratePerHour.toFixed(2)}/hr`),
        ];
    }
}

class CostEstimateItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
    }
}

class SeverityGroupItem extends vscode.TreeItem {
    children: IssueItem[];

    constructor(severity: Severity, issues: (CodeIssue | Issue)[]) {
        super(
            `${severity.toUpperCase()} (${issues.length})`,
            vscode.TreeItemCollapsibleState.Expanded,
        );
        this.iconPath = new vscode.ThemeIcon(
            severityThemeIcon(severity),
            severityColor(severity),
        );
        this.children = issues.map(i => new IssueItem(i));
    }
}

class IssueItem extends vscode.TreeItem {
    constructor(issue: CodeIssue | Issue) {
        super(issue.title, vscode.TreeItemCollapsibleState.None);

        this.description = issue.location ?? '';
        this.tooltip = new vscode.MarkdownString(
            `**${issue.title}**\n\n${issue.description}\n\n` +
            (issue.fix?.description ? `**Fix:** ${issue.fix.description}` : ''),
        );

        this.iconPath = new vscode.ThemeIcon(
            severityThemeIcon(issue.severity as Severity),
            severityColor(issue.severity as Severity),
        );

        // Navigate to location on click
        if ('line' in issue && typeof issue.line === 'number') {
            this.command = {
                command: 'revealLine',
                title: 'Go to line',
                arguments: [{ lineNumber: issue.line, at: 'center' }],
            };
        }
    }
}

class OutputGroupItem extends vscode.TreeItem {
    children: WriteOperationItem[];

    constructor(ops: WriteOperation[]) {
        super('Outputs', vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('database');
        this.children = ops.map(op => new WriteOperationItem(op));
    }
}

class WriteOperationItem extends vscode.TreeItem {
    children: WriteColumnItem[];

    constructor(op: WriteOperation) {
        const writeLabel = op.isStreaming ? 'writeStream' : 'write';
        const destSuffix = op.destination ? ` → "${op.destination}"` : '';
        const label = `${op.varName}.${writeLabel}${destSuffix}`;
        const colCount = op.columns.length;
        const state = colCount > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        super(label, state);
        this.description = colCount > 0 ? `${colCount} column${colCount !== 1 ? 's' : ''}` : 'schema unknown';
        this.iconPath = new vscode.ThemeIcon(op.isStreaming ? 'broadcast' : 'arrow-right');
        this.command = {
            command: 'revealLine',
            title: 'Go to write statement',
            arguments: [{ lineNumber: op.writeLine, at: 'center' }],
        };
        this.children = op.columns.map(c => new WriteColumnItem(c.name, c.type));
    }
}

class WriteColumnItem extends vscode.TreeItem {
    constructor(colName: string, colType: string) {
        super(colName, vscode.TreeItemCollapsibleState.None);
        this.description = colType;
        this.iconPath = new vscode.ThemeIcon('symbol-field');
    }
}

class ProgressGroupItem extends vscode.TreeItem {
    children: ProgressStepItem[];
    constructor(steps: ProgressStep[]) {
        super('Execution Progress', vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('pulse');
        this.children = steps.map(s => new ProgressStepItem(s));
    }
}

class ProgressStepItem extends vscode.TreeItem {
    constructor(step: ProgressStep) {
        super(step.label, vscode.TreeItemCollapsibleState.None);
        this.description = step.detail;
        const icons: Record<ProgressStepStatus, string> = {
            pending: 'circle-outline',
            running: 'loading~spin',
            done: 'pass',
            error: 'error',
        };
        this.iconPath = new vscode.ThemeIcon(icons[step.status]);
    }
}


function severityThemeIcon(severity: Severity): string {
    switch (severity) {
        case Severity.CRITICAL: return 'error';
        case Severity.WARNING: return 'warning';
        case Severity.INFO: return 'info';
        case Severity.SUGGESTION: return 'lightbulb';
    }
}

function severityColor(severity: Severity): vscode.ThemeColor | undefined {
    switch (severity) {
        case Severity.CRITICAL: return new vscode.ThemeColor('errorForeground');
        case Severity.WARNING: return new vscode.ThemeColor('list.warningForeground');
        default: return undefined;
    }
}
