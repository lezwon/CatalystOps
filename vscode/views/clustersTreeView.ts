/**
 * Clusters Tree View — sidebar panel listing Databricks interactive clusters.
 * Allows one-click SSH connection to any running cluster.
 */

import * as vscode from 'vscode';
import { ClusterInfo, ClusterState } from '../databricks/clustersApi';

type ClusterTreeItem = ClusterItem | StateItem;

export class ClustersTreeDataProvider implements vscode.TreeDataProvider<ClusterTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ClusterTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private clusters: ClusterInfo[] = [];
    private loading = false;
    private errorMessage: string | null = null;

    setClusters(clusters: ClusterInfo[]): void {
        this.clusters = clusters;
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

    getTreeItem(element: ClusterTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ClusterTreeItem): ClusterTreeItem[] {
        if (this.loading) {
            return element ? [] : [new StateItem('Loading clusters…', 'loading')];
        }
        if (this.errorMessage) {
            return element ? [] : [new StateItem(this.errorMessage, 'error')];
        }
        if (this.clusters.length === 0 && !element) {
            return [new StateItem('No interactive clusters found. Click ↺ to refresh.', 'empty')];
        }
        if (element) { return []; }
        return this.clusters.map(c => new ClusterItem(c));
    }
}

export class ClusterItem extends vscode.TreeItem {
    readonly cluster: ClusterInfo;

    constructor(cluster: ClusterInfo) {
        super(cluster.clusterName, vscode.TreeItemCollapsibleState.None);
        this.cluster = cluster;
        const state = cluster.state;
        const isActive = state === 'RUNNING' || state === 'PENDING' || state === 'RESTARTING' || state === 'RESIZING';
        this.contextValue = isActive ? 'catalystops.clusterItem.running' : 'catalystops.clusterItem';
        const workers = cluster.numWorkers !== undefined ? ` · ${cluster.numWorkers}w` : '';
        this.description = `${state.toLowerCase()}${workers}`;
        this.tooltip = [
            `Cluster: ${cluster.clusterName}`,
            `ID: ${cluster.clusterId}`,
            `State: ${state}`,
            `Runtime: ${cluster.sparkVersion}`,
            cluster.singleUserName ? `User: ${cluster.singleUserName}` : '',
        ].filter(Boolean).join('\n');

        this.iconPath = clusterIcon(state);
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

function clusterIcon(state: ClusterState): vscode.ThemeIcon {
    switch (state) {
        case 'RUNNING':
            return new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'));
        case 'PENDING':
        case 'RESTARTING':
        case 'RESIZING':
            return new vscode.ThemeIcon('loading~spin');
        case 'TERMINATING':
        case 'TERMINATED':
            return new vscode.ThemeIcon('vm', new vscode.ThemeColor('disabledForeground'));
        case 'ERROR':
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        default:
            return new vscode.ThemeIcon('vm');
    }
}
