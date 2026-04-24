/**
 * Bundle Tasks Tree View — sidebar panel showing Python tasks from databricks.yml.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { BundleConfig, BundleTask } from '../databricks/bundleParser';

type BundleTreeItem = BundleHeaderItem | BundleTaskItem | BundleStateItem;

export class BundleTasksTreeDataProvider implements vscode.TreeDataProvider<BundleTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BundleTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private bundle: BundleConfig | undefined;

    setBundle(bundle: BundleConfig | undefined): void {
        this.bundle = bundle;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: BundleTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BundleTreeItem): BundleTreeItem[] {
        if (!element) {
            // Root level
            if (!this.bundle) {
                return [new BundleStateItem('No databricks.yml found in workspace', 'empty')];
            }
            if (this.bundle.tasks.length === 0) {
                return [new BundleStateItem('No Python tasks found (spark_python_task / notebook_task)', 'empty')];
            }
            return [new BundleHeaderItem(this.bundle)];
        }

        if (element instanceof BundleHeaderItem && this.bundle) {
            return this.bundle.tasks.map(t => new BundleTaskItem(t));
        }

        return [];
    }
}

export class BundleHeaderItem extends vscode.TreeItem {
    constructor(bundle: BundleConfig) {
        super(bundle.name, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'catalystops.bundleHeader';
        this.description = `${bundle.tasks.length} task${bundle.tasks.length !== 1 ? 's' : ''}`;
        this.iconPath = new vscode.ThemeIcon('package');
        this.tooltip = bundle.bundlePath;
    }
}

export class BundleTaskItem extends vscode.TreeItem {
    readonly task: BundleTask;

    constructor(task: BundleTask) {
        const label = `${task.jobName} / ${task.taskKey}`;
        super(label, vscode.TreeItemCollapsibleState.None);
        this.task = task;
        this.contextValue = 'catalystops.bundleTaskItem';

        const rel = path.basename(task.pythonFile);
        this.description = rel;
        this.tooltip = task.pythonFile;
        this.iconPath = new vscode.ThemeIcon(
            task.taskType === 'notebook_task' ? 'notebook' : 'file-code',
        );

        // Single click opens the file
        this.command = {
            command: 'catalystops.openBundleTask',
            title: 'Open File',
            arguments: [task],
        };
    }
}

class BundleStateItem extends vscode.TreeItem {
    constructor(label: string, kind: 'empty' | 'error') {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(kind === 'error' ? 'error' : 'info');
    }
}
