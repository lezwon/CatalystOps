/**
 * Interactive Databricks connection setup
 */

import * as vscode from 'vscode';

export async function configureConnection(): Promise<void> {
    const config = vscode.workspace.getConfiguration('catalystops');

    const host = await vscode.window.showInputBox({
        prompt: 'Databricks workspace URL',
        placeHolder: 'https://myworkspace.cloud.databricks.com',
        value: config.get<string>('databricks.host', ''),
    });

    if (host === undefined) { return; } // Cancelled

    const token = await vscode.window.showInputBox({
        prompt: 'Databricks personal access token',
        placeHolder: 'dapi...',
        password: true,
        value: config.get<string>('databricks.token', ''),
    });

    if (token === undefined) { return; }

    const clusterId = await vscode.window.showInputBox({
        prompt: 'Interactive cluster ID',
        placeHolder: '1234-567890-abcdef12',
        value: config.get<string>('databricks.clusterId', ''),
    });

    if (clusterId === undefined) { return; }

    await config.update('databricks.host', host, vscode.ConfigurationTarget.Global);
    await config.update('databricks.token', token, vscode.ConfigurationTarget.Global);
    await config.update('databricks.clusterId', clusterId, vscode.ConfigurationTarget.Global);

    vscode.window.showInformationMessage('CatalystOps: Databricks connection configured successfully.');
}
