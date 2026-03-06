/**
 * Explain Tree View - Sidebar TreeDataProvider for the physical plan.
 * Shown in the "Explain Plan" panel of the CatalystOps sidebar.
 */

import * as vscode from 'vscode';
import { AnalysisResult } from '../models/types';
import { PlanIssue } from '../analysis/planParser';
import { PlanNode, buildPlanTrees } from '../analysis/planTreeBuilder';

export type ExplainTreeItem = DataFrameGroupItem | PlanNodeItem;

export class ExplainTreeDataProvider implements vscode.TreeDataProvider<ExplainTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ExplainTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private groups: DataFrameGroupItem[] = [];

    update(
        results: AnalysisResult[],
        planIssues: PlanIssue[],
        dfLineMap: Map<string, number>,
    ): void {
        const roots = buildPlanTrees(results, planIssues, dfLineMap);

        const byDf = new Map<string, PlanNode[]>();
        for (const root of roots) {
            const key = root.dataframeName ?? '(unknown)';
            if (!byDf.has(key)) { byDf.set(key, []); }
            byDf.get(key)!.push(root);
        }

        this.groups = Array.from(byDf.entries()).map(([name, nodes]) => {
            const issueCount = countIssues(nodes);
            return new DataFrameGroupItem(name, nodes, issueCount);
        });

        this._onDidChangeTreeData.fire(undefined);
    }

    clear(): void {
        this.groups = [];
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ExplainTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ExplainTreeItem): ExplainTreeItem[] {
        if (!element) { return this.groups; }
        if (element instanceof DataFrameGroupItem) { return element.nodeItems; }
        if (element instanceof PlanNodeItem) { return element.childItems; }
        return [];
    }
}

function countIssues(nodes: PlanNode[]): number {
    let count = 0;
    for (const node of nodes) {
        if (node.issue) { count++; }
        count += countIssues(node.children);
    }
    return count;
}

export class DataFrameGroupItem extends vscode.TreeItem {
    nodeItems: PlanNodeItem[];

    constructor(dfName: string, nodes: PlanNode[], issueCount: number) {
        super(dfName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = issueCount > 0
            ? `${issueCount} issue${issueCount !== 1 ? 's' : ''}`
            : '';
        this.iconPath = new vscode.ThemeIcon('symbol-class');
        this.nodeItems = nodes.map(n => new PlanNodeItem(n));
    }
}

export class PlanNodeItem extends vscode.TreeItem {
    readonly planNode: PlanNode;
    childItems: PlanNodeItem[];

    constructor(node: PlanNode) {
        const state = node.children.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;

        const costLabel = node.issue ? ` — ${node.issue.costPoints} pts` : '';
        super(`${node.operatorName}${costLabel}`, state);

        this.planNode = node;

        const rawPreview = node.rawLine.length > 60
            ? node.rawLine.substring(0, 57) + '...'
            : node.rawLine;
        this.description = rawPreview !== node.operatorName + costLabel ? rawPreview : '';

        const tooltipText = node.issue
            ? `**${node.issue.name}**\n\n${node.issue.description}`
            : `\`${node.operatorName}\``;
        this.tooltip = new vscode.MarkdownString(tooltipText);

        this.iconPath = new vscode.ThemeIcon(severityIcon(node.severity));
        this.contextValue = getContextValue(node.operatorName, node.issue);

        if (node.sourceLine !== undefined) {
            this.command = {
                command: 'catalystops.jumpToLine',
                title: 'Jump to source line',
                arguments: [node.sourceLine],
            };
        }

        this.childItems = node.children.map(c => new PlanNodeItem(c));
    }
}

function severityIcon(severity: 'critical' | 'warning' | 'info' | 'none'): string {
    switch (severity) {
        case 'critical': return 'error';
        case 'warning': return 'warning';
        case 'info': return 'info';
        case 'none': return 'circle-outline';
    }
}

function getContextValue(operatorName: string, issue?: PlanIssue): string {
    if (operatorName.includes('SortMergeJoin') || operatorName.includes('PhotonSortMergeJoin')) {
        return 'join-sortmerge';
    }
    if (operatorName.includes('CartesianProduct')) {
        return 'join-cartesian';
    }
    if (operatorName.includes('ShuffledHashJoin')) {
        return 'join-shuffled';
    }
    if (operatorName.includes('Exchange') && !operatorName.includes('Broadcast')) {
        return 'exchange';
    }
    if (operatorName.includes('BroadcastHashJoin') || operatorName.includes('BroadcastNestedLoop')) {
        return 'broadcast';
    }
    if (operatorName.includes('FileScan') || operatorName.includes('PhotonScan')) {
        if (issue?.name === 'RepeatedFileScan') { return 'scan-repeated'; }
        return 'scan';
    }
    return 'node';
}
