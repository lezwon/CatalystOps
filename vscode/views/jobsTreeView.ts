/**
 * Jobs Tree View — sidebar panel listing Databricks workspace jobs with last-run status.
 */

import * as vscode from 'vscode';
import { JobSummary, RunSummary } from '../databricks/jobsApi';

export interface JobWithRun {
    job: JobSummary;
    lastRun?: RunSummary;
}

type JobTreeItem = JobItem | StateItem;

export class JobsTreeDataProvider implements vscode.TreeDataProvider<JobTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<JobTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private jobs: JobWithRun[] = [];
    private loading = false;
    private errorMessage: string | null = null;

    setJobs(jobs: JobWithRun[]): void {
        this.jobs = jobs;
        this.loading = false;
        this.errorMessage = null;
        this._onDidChangeTreeData.fire(undefined);
    }

    setLoading(loading: boolean): void {
        this.loading = loading;
        if (loading) { this.errorMessage = null; }
        this._onDidChangeTreeData.fire(undefined);
    }

    setError(message: string): void {
        this.errorMessage = message;
        this.loading = false;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: JobTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: JobTreeItem): JobTreeItem[] {
        if (this.loading) {
            return element ? [] : [new StateItem('Loading jobs…', 'loading')];
        }
        if (this.errorMessage) {
            return element ? [] : [new StateItem(`${this.errorMessage}`, 'error')];
        }
        if (this.jobs.length === 0 && !element) {
            return [new StateItem('No jobs found. Click ↺ to refresh.', 'empty')];
        }
        if (element) { return []; }
        return this.jobs.map(j => new JobItem(j));
    }
}

export class JobItem extends vscode.TreeItem {
    readonly jobWithRun: JobWithRun;

    constructor(jwr: JobWithRun) {
        super(jwr.job.name, vscode.TreeItemCollapsibleState.None);
        this.jobWithRun = jwr;
        this.contextValue = 'catalystops.jobItem';

        const run = jwr.lastRun;
        if (!run) {
            this.description = 'no runs';
            this.iconPath = new vscode.ThemeIcon('briefcase');
            return;
        }

        const state = run.state.life_cycle_state;
        const result = run.state.result_state;
        const age = formatAge(run.startTimeMs);
        const dur = run.durationMs ? ` · ${formatDuration(run.durationMs)}` : '';
        this.description = `${age}${dur}`;
        this.tooltip = `Run #${run.numberInJob ?? run.runId} · started ${new Date(run.startTimeMs).toLocaleString()}\nDouble-click to analyze`;

        if (state === 'TERMINATED' && result === 'SUCCESS') {
            this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        } else if (result === 'FAILED' || state === 'INTERNAL_ERROR') {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        } else if (state === 'RUNNING' || state === 'TERMINATING') {
            this.iconPath = new vscode.ThemeIcon('loading~spin');
        } else {
            this.iconPath = new vscode.ThemeIcon('briefcase');
        }

        // Fires on every single click — double-click detection is handled in the command handler
        this.command = {
            command: 'catalystops.jobItemClicked',
            title: 'Analyze Last Run',
            arguments: [run.runId, jwr.job.name],
        };
    }
}

class StateItem extends vscode.TreeItem {
    constructor(label: string, kind: 'loading' | 'error' | 'empty') {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (kind === 'loading') {
            this.iconPath = new vscode.ThemeIcon('loading~spin');
        } else if (kind === 'error') {
            this.iconPath = new vscode.ThemeIcon('error');
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

function formatAge(startMs: number): string {
    const diffMs = Date.now() - startMs;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) { return `${mins}m ago`; }
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) { return `${hrs}h ago`; }
    return `${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(ms: number): string {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) { return '<1m'; }
    if (mins < 60) { return `${mins}m`; }
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
