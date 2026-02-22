/**
 * Interactive Databricks connection setup.
 * Auto-detects profiles from ~/.databrickscfg and shows QuickPick.
 * Falls back to manual input boxes.
 */

import * as vscode from 'vscode';
import { listProfiles, DatabricksProfile } from '../config/databricksConfig';

export async function configureConnection(): Promise<void> {
    const config = vscode.workspace.getConfiguration('catalystops');
    const configPath = config.get<string>('databricks.configPath', '~/.databrickscfg');
    const profiles = listProfiles(configPath);

    if (profiles.length > 0) {
        // Show QuickPick with detected profiles
        const items: vscode.QuickPickItem[] = profiles.map(p => ({
            label: p.name,
            description: p.host,
            detail: p.clusterId
                ? `Cluster: ${p.clusterId}`
                : 'No cluster ID configured',
        }));

        items.push({
            label: '$(add) Enter manually...',
            description: 'Type host, token, and optional cluster ID manually',
        });

        const picked = await vscode.window.showQuickPick(items, {
            title: 'CatalystOps: Select Databricks Profile',
            placeHolder: 'Choose a profile from ~/.databrickscfg',
        });

        if (!picked) { return; }

        if (picked.label.includes('Enter manually')) {
            await manualSetup(config);
            return;
        }

        // Use the selected profile
        const profile = profiles.find(p => p.name === picked.label);
        if (!profile) { return; }

        const target = vscode.workspace.workspaceFolders
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        await config.update('databricks.profile', profile.name, target);
        await config.update('databricks.host', profile.host, target);

        // If no cluster ID in config, ask for it (blank = serverless)
        let clusterId = profile.clusterId || '';
        if (!clusterId) {
            const input = await vscode.window.showInputBox({
                prompt: `No cluster_id in profile "${profile.name}". Enter cluster ID (leave blank to use serverless)`,
                placeHolder: '1234-567890-abcdef12',
            });
            if (input === undefined) { return; }
            clusterId = input;
        }

        await config.update('databricks.clusterId', clusterId, target);
        if (!clusterId) {
            await config.update('databricks.executionMode', 'serverless', target);
        }
        // Clear any stale token from VS Code settings so the one in ~/.databrickscfg is used
        await config.update('databricks.token', '', target);

        const modeLabel = clusterId ? `cluster ${clusterId}` : 'serverless';
        vscode.window.showInformationMessage(
            `CatalystOps: Connected using profile "${profile.name}" (${profile.host}) — ${modeLabel}`,
        );
    } else {
        // No config file found — fall back to manual
        vscode.window.showInformationMessage(
            'CatalystOps: No ~/.databrickscfg found. Enter connection details manually.',
        );
        await manualSetup(config);
    }
}

async function manualSetup(config: vscode.WorkspaceConfiguration): Promise<void> {
    const host = await vscode.window.showInputBox({
        prompt: 'Databricks workspace URL',
        placeHolder: 'https://myworkspace.cloud.databricks.com',
        value: config.get<string>('databricks.host', ''),
    });

    if (host === undefined) { return; }

    const token = await vscode.window.showInputBox({
        prompt: 'Databricks personal access token',
        placeHolder: 'dapi...',
        password: true,
        value: config.get<string>('databricks.token', ''),
    });

    if (token === undefined) { return; }

    const clusterId = await vscode.window.showInputBox({
        prompt: 'Interactive cluster ID (leave blank to use serverless)',
        placeHolder: '1234-567890-abcdef12',
        value: config.get<string>('databricks.clusterId', ''),
    });

    if (clusterId === undefined) { return; }

    const target = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    await config.update('databricks.host', host, target);
    await config.update('databricks.token', token, target);
    await config.update('databricks.clusterId', clusterId, target);
    if (!clusterId) {
        await config.update('databricks.executionMode', 'serverless', target);
    }

    const modeLabel = clusterId ? `cluster ${clusterId}` : 'serverless';
    vscode.window.showInformationMessage(`CatalystOps: Databricks connection configured successfully — ${modeLabel}.`);
}
