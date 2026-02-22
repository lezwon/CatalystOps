/**
 * VS Code settings reader for catalystops.* configuration
 */

import * as vscode from 'vscode';
import { readDatabricksConfig } from './databricksConfig';

export interface DatabricksConnectionConfig {
    host: string;
    token: string;
    clusterId?: string;
    executionMode: 'cluster' | 'serverless';
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
    const executionMode = config.get<'cluster' | 'serverless'>('databricks.executionMode', 'cluster');

    // Always try to fill missing values from ~/.databrickscfg
    const configPath = config.get<string>('databricks.configPath', '~/.databrickscfg');
    const profile = config.get<string>('databricks.profile', 'DEFAULT');

    const fileConfig = readDatabricksConfig(configPath, profile);
    if (fileConfig) {
        if (!host) { host = fileConfig.host; }
        if (!token) { token = fileConfig.token; }
        if (!clusterId && fileConfig.clusterId) { clusterId = fileConfig.clusterId; }
    }

    const missing: string[] = [];
    if (!host) { missing.push('host'); }
    if (!token) { missing.push('token'); }
    // clusterId only required for cluster mode
    if (executionMode === 'cluster' && !clusterId) { missing.push('clusterId'); }

    if (missing.length > 0) {
        const src = fileConfig ? `profile "${profile}" in ${configPath}` : `${configPath} (file not found or profile "${profile}" missing)`;
        vscode.window.showWarningMessage(
            `CatalystOps: Missing ${missing.join(', ')}. Checked VS Code settings and ${src}. Run "CatalystOps: Configure Databricks Connection".`,
        );
        return undefined;
    }

    // Normalize host URL
    host = host.replace(/\/+$/, '');
    if (!host.startsWith('https://')) {
        host = 'https://' + host;
    }

    return { host, token, clusterId: clusterId || undefined, executionMode };
}

export function isLocalAnalysisEnabled(): boolean {
    return vscode.workspace.getConfiguration('catalystops')
        .get<boolean>('analysis.enableLocalCodeAnalysis', true);
}
