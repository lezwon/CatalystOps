/**
 * Billing Tree View — sidebar tree showing spending summary.
 */

import * as vscode from 'vscode';
import { BillingSummary } from '../billing/billingTypes';

type BillingTreeItem = SummaryHeaderItem | GroupItem | EntryItem | StateItem;

export class BillingTreeDataProvider implements vscode.TreeDataProvider<BillingTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BillingTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private summary: BillingSummary | null = null;
    private loading = false;
    private errorMessage: string | null = null;

    setSummary(summary: BillingSummary | null): void {
        this.summary = summary;
        this.loading = false;
        this.errorMessage = null;
        this._onDidChangeTreeData.fire(undefined);
    }

    setLoading(loading: boolean): void {
        this.loading = loading;
        if (loading) { this.errorMessage = null; }
        this._onDidChangeTreeData.fire(undefined);
    }

    setError(message: string | null): void {
        this.errorMessage = message;
        this.loading = false;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: BillingTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BillingTreeItem): BillingTreeItem[] {
        if (this.loading) {
            return element ? [] : [new StateItem('Fetching billing data…', 'loading')];
        }

        if (this.errorMessage) {
            return element ? [] : [new StateItem(`Error: ${this.errorMessage}`, 'error')];
        }

        if (!this.summary) {
            return element ? [] : [new StateItem('Fetch Billing Data', 'fetch')];
        }

        if (!element) {
            return this.getRootItems(this.summary);
        }

        if (element instanceof GroupItem) {
            return element.children;
        }

        return [];
    }

    private getRootItems(summary: BillingSummary): BillingTreeItem[] {
        const periodLabel =
            summary.period === 'day'   ? 'Last 24 hrs' :
            summary.period === 'week'  ? 'Last 7 days' :
            summary.period === 'month' ? 'Last 30 days' :
            `${summary.startDate} – ${summary.endDate}`;

        const header = new SummaryHeaderItem(
            `${periodLabel}: $${summary.totalDollars.toFixed(2)}  (${summary.totalDBUs.toFixed(1)} DBUs)`,
        );

        const byUser = new GroupItem(
            'By User', 'person',
            summary.byUser.map(u => new EntryItem(u.user, `$${u.dollars.toFixed(2)}`)),
        );

        const byJob = new GroupItem(
            'By Job', 'briefcase',
            summary.byJob.map(j => new EntryItem(`${j.jobName} (${j.jobId})`, `$${j.dollars.toFixed(2)}`)),
        );

        const byWorkload = new GroupItem(
            'By Workload', 'server',
            summary.byWorkload.map(w => new EntryItem(w.type, `$${w.dollars.toFixed(2)}`)),
        );

        return [header, byUser, byJob, byWorkload];
    }
}

class SummaryHeaderItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('graph');
    }
}

class GroupItem extends vscode.TreeItem {
    children: EntryItem[];
    constructor(label: string, icon: string, children: EntryItem[]) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.children = children;
    }
}

class EntryItem extends vscode.TreeItem {
    constructor(label: string, description: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
    }
}

class StateItem extends vscode.TreeItem {
    constructor(label: string, kind: 'loading' | 'error' | 'fetch') {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (kind === 'loading') {
            this.iconPath = new vscode.ThemeIcon('loading~spin');
        } else if (kind === 'error') {
            this.iconPath = new vscode.ThemeIcon('error');
        } else {
            // Clickable fetch button
            this.iconPath = new vscode.ThemeIcon('cloud-download');
            this.command = {
                command: 'catalystops.showBillingDashboard',
                title: 'Fetch Billing Data',
            };
            this.tooltip = 'Click to fetch the last 7 days of billing data';
        }
    }
}
