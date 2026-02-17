/**
 * VS Code settings reader for catalystops.* configuration
 */

import * as vscode from 'vscode';
import { readDatabricksConfig } from './databricksConfig';

export interface DatabricksConnectionConfig {
    host: string;
    token: string;
    clusterId: string;
}

/**
 * Get Databricks connection config from VS Code settings or .databricks/config file.
 * Priority: VS Code settings > .databricks/config file
 */
export function getConnectionConfig(): DatabricksConnectionConfig | undefined {
    const config = vscode.workspace.getConfiguration('catalystops');

    let host = config.get<string>('databricks.host', '');
    let token = config.get<string>('databricks.token', '');
    let clusterId = config.get<string>('databricks.clusterId', '');

    // Fall back to .databricks/config file
    if (!host || !token) {
        const configPath = config.get<string>('databricks.configPath', '~/.databricks/config');
        const profile = config.get<string>('databricks.profile', 'DEFAULT');

        const fileConfig = readDatabricksConfig(configPath, profile);
        if (fileConfig) {
            if (!host) { host = fileConfig.host; }
            if (!token) { token = fileConfig.token; }
            if (!clusterId && fileConfig.clusterId) { clusterId = fileConfig.clusterId; }
        }
    }

    if (!host || !token || !clusterId) {
        return undefined;
    }

    // Normalize host URL
    host = host.replace(/\/+$/, '');
    if (!host.startsWith('https://')) {
        host = 'https://' + host;
    }

    return { host, token, clusterId };
}

export function shouldInstallSparkOptimizer(): boolean {
    return vscode.workspace.getConfiguration('catalystops')
        .get<boolean>('cluster.installSparkOptimizer', true);
}

export function isLocalAnalysisEnabled(): boolean {
    return vscode.workspace.getConfiguration('catalystops')
        .get<boolean>('analysis.enableLocalCodeAnalysis', true);
}
