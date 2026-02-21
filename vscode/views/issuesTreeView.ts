/**
 * Issues Tree View - Sidebar tree with issues grouped by severity
 */

import * as vscode from 'vscode';
import { CodeIssue, Severity, AnalysisResult, Issue } from '../models/types';
import { SEVERITY_PRIORITY } from '../models/types';

export type ProgressStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface ProgressStep {
    label: string;
    status: ProgressStepStatus;
    detail?: string;
}

type TreeItem = ProgressGroupItem | ProgressStepItem | SeverityGroupItem | IssueItem;

export class IssuesTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private issues: CodeIssue[] = [];
    private clusterIssues: Issue[] = [];
    private progressSteps: ProgressStep[] = [];

    setProgress(steps: ProgressStep[]): void {
        this.progressSteps = [...steps];
        this._onDidChangeTreeData.fire(undefined);
    }

    clearProgress(): void {
        this.progressSteps = [];
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
            if (this.progressSteps.length > 0) {
                items.push(new ProgressGroupItem(this.progressSteps));
            }
            items.push(...this.getSeverityGroups());
            return items;
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
