/**
 * VS Code settings reader for catalystops.* configuration
 */

import * as vscode from 'vscode';
import { readDatabricksConfig } from './databricksConfig';
import { isAzureHost } from '../databricks/azureCliAuth';

export interface DatabricksConnectionConfig {
    host: string;
    token: string;
    authType: 'pat' | 'azure-cli';
    clusterId?: string;
    executionMode: 'cluster' | 'serverless' | 'ssh';
    sshConnectionName?: string;
}

/**
 * Get Databricks connection config.
 * Merges VS Code settings with ~/.databrickscfg file.
 * Any value from VS Code settings takes priority; missing values filled from file.
 */
export function getConnectionConfig(): DatabricksConnectionConfig | undefined {
    const config = vscode.workspace.getConfiguration('catalystops');

    let host = config.get<string>('databricks.host', '');
    let token = config.get<string>('databricks.token', '');
    let clusterId = config.get<string>('databricks.clusterId', '');
    let executionMode = config.get<'cluster' | 'serverless' | 'ssh'>('databricks.executionMode', 'cluster');
    const sshEnabled = config.get<boolean>('connection.sshTunnel.enabled', false);
    const sshConnectionName = config.get<string>('connection.sshTunnel.connectionName', '').trim();
    if (sshEnabled && sshConnectionName) {
        executionMode = 'ssh';
    }

    // Always try to fill missing values from ~/.databrickscfg
    const configPath = config.get<string>('databricks.configPath', '~/.databrickscfg');
    const profile = config.get<string>('databricks.profile', 'DEFAULT');

    // Read explicit authType setting before file config so we know whether to use a file token
    const configuredAuthType = config.get<string>('databricks.authType', 'pat');

    const fileConfig = readDatabricksConfig(configPath, profile);
    if (fileConfig) {
        if (!host) { host = fileConfig.host; }
        // Don't pull a PAT from .databrickscfg when azure-cli auth is explicitly configured
        if (!token && configuredAuthType !== 'azure-cli') { token = fileConfig.token; }
        if (!clusterId && fileConfig.clusterId) { clusterId = fileConfig.clusterId; }
    }

    // Blank cluster ID implies serverless
    if (executionMode === 'cluster' && !clusterId) {
        executionMode = 'serverless';
    }

    // Normalize host URL early so isAzureHost() check works
    host = host.replace(/\/+$/, '');
    if (host && !host.startsWith('https://')) {
        host = 'https://' + host;
    }

    // Determine auth type: explicit setting takes priority; auto-detect for Azure hosts with no token
    const authType: 'pat' | 'azure-cli' =
        configuredAuthType === 'azure-cli'
            ? 'azure-cli'
            : (!token && isAzureHost(host)) ? 'azure-cli' : 'pat';

    const missing: string[] = [];
    if (!host) { missing.push('host'); }
    if (!token && authType !== 'azure-cli') { missing.push('token'); }

    if (missing.length > 0) {
        const src = fileConfig ? `profile "${profile}" in ${configPath}` : `${configPath} (file not found or profile "${profile}" missing)`;
        vscode.window.showWarningMessage(
            `CatalystOps: Missing ${missing.join(', ')}. Checked VS Code settings and ${src}. Run "CatalystOps: Configure Databricks Connection".`,
        );
        return undefined;
    }

    return {
        host,
        token,
        authType,
        clusterId: clusterId || undefined,
        executionMode,
        sshConnectionName: executionMode === 'ssh' ? sshConnectionName : undefined,
    };
}

export function isLocalAnalysisEnabled(): boolean {
    return vscode.workspace.getConfiguration('catalystops')
        .get<boolean>('analysis.enableLocalCodeAnalysis', true);
}
