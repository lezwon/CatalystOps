/**
 * Interactive Databricks connection setup.
 *
 * Flow:
 *  1. Detect available auth methods in parallel (Azure CLI, ~/.databrickscfg)
 *  2. Show a QuickPick with only what's available
 *  3. Route to the appropriate sub-flow:
 *     - Azure CLI  → fetch workspaces from Azure, pick one, done (no token needed)
 *     - .databrickscfg → pick profile, done
 *     - PAT manual → enter host + token manually
 */

import * as vscode from 'vscode';
import { listProfiles, DatabricksProfile } from '../config/databricksConfig';
import {
    checkAzureCliLogin,
    listAzureWorkspaces,
    getAzureWorkspaceUrl,
} from '../databricks/azureCliAuth';
import { checkGcpAdcLogin } from '../databricks/gcpAuth';

// ─── Labels used to identify picks ────────────────────────────────────────────
const LABEL_AZURE  = '$(azure) Azure CLI';
const LABEL_GCP    = '$(cloud) GCP (gcloud)';
const LABEL_CFG    = '$(file-text) ~/.databrickscfg';
const LABEL_PAT    = '$(key) Personal Access Token';

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function configureConnection(): Promise<void> {
    const config = vscode.workspace.getConfiguration('catalystops');
    const configPath = config.get<string>('databricks.configPath', '~/.databrickscfg');

    // Detect available auth methods in parallel — failures are soft (null)
    const [azureAccount, gcpAccount, profiles] = await Promise.all([
        checkAzureCliLogin().catch(() => null),
        checkGcpAdcLogin().catch(() => null),
        Promise.resolve(listProfiles(configPath)),
    ]);

    // Build QuickPick showing only what's available
    const items: vscode.QuickPickItem[] = [];

    if (azureAccount) {
        items.push({
            label: LABEL_AZURE,
            description: `Signed in as ${azureAccount.user}`,
            detail: 'Fetch your Databricks workspaces from Azure and authenticate with az login',
        });
    }

    if (gcpAccount) {
        items.push({
            label: LABEL_GCP,
            description: `Signed in as ${gcpAccount.account}`,
            detail: 'Authenticate using GCP Application Default Credentials (gcloud auth application-default login)',
        });
    }

    if (profiles.length > 0) {
        items.push({
            label: LABEL_CFG,
            description: `${profiles.length} profile${profiles.length > 1 ? 's' : ''} found`,
            detail: profiles.map(p => p.name).join(', '),
        });
    }

    items.push({
        label: LABEL_PAT,
        description: 'Enter workspace URL and personal access token manually',
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'CatalystOps: Connect to Databricks',
        placeHolder: 'Choose how to connect',
    });

    if (!picked) { return; }

    const target = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    if (picked.label === LABEL_AZURE) {
        await azureCliFlow(config, target);
    } else if (picked.label === LABEL_GCP) {
        await gcpAdcFlow(config, target);
    } else if (picked.label === LABEL_CFG) {
        await databricksCfgFlow(config, target, profiles);
    } else {
        await manualPatFlow(config, target);
    }
}

// ─── Azure CLI flow ────────────────────────────────────────────────────────────

async function azureCliFlow(
    config: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget,
): Promise<void> {
    // Fetch workspaces with progress indicator
    let workspaces: Awaited<ReturnType<typeof listAzureWorkspaces>>;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CatalystOps: Fetching Databricks workspaces from Azure…' },
        async () => { workspaces = await listAzureWorkspaces(); },
    );

    if (!workspaces! || workspaces.length === 0) {
        vscode.window.showErrorMessage(
            'CatalystOps: No Databricks workspaces found in your Azure subscription. ' +
            'Check that your az login account has access to at least one Databricks workspace.',
        );
        return;
    }

    // Let user pick a workspace by name
    const workspacePick = await vscode.window.showQuickPick(
        workspaces.map(w => ({
            label: w.name,
            description: w.resourceGroup,
            detail: w.location,
            resourceId: w.resourceId,
        })),
        { title: 'CatalystOps: Select Databricks Workspace', placeHolder: 'Choose a workspace' },
    );

    if (!workspacePick) { return; }

    // Resolve workspace URL
    let host: string;
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `CatalystOps: Resolving URL for "${workspacePick.label}"…` },
            async () => { host = await getAzureWorkspaceUrl((workspacePick as any).resourceId); },
        );
    } catch (err) {
        vscode.window.showErrorMessage(`CatalystOps: Failed to get workspace URL — ${err instanceof Error ? err.message : String(err)}`);
        return;
    }


    await saveSettings(config, target, {
        host: host!,
        token: '',
        authType: 'azure-cli',
        profile: '',
    });

    vscode.window.showInformationMessage(
        `CatalystOps: Connected to "${workspacePick.label}" via Azure CLI`,
    );
}

// ─── GCP ADC flow ─────────────────────────────────────────────────────────────

async function gcpAdcFlow(
    config: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget,
): Promise<void> {
    const host = await vscode.window.showInputBox({
        prompt: 'Databricks workspace URL',
        placeHolder: 'https://1234567890123456.7.gcp.databricks.com',
        value: config.get<string>('databricks.host', ''),
    });
    if (host === undefined) { return; }


    await saveSettings(config, target, {
        host,
        token: '',
        authType: 'gcp-adc',
        profile: '',
    });

    vscode.window.showInformationMessage(
        `CatalystOps: Connected to "${host}" via GCP ADC`,
    );
}

// ─── ~/.databrickscfg flow ────────────────────────────────────────────────────

async function databricksCfgFlow(
    config: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget,
    profiles: DatabricksProfile[],
): Promise<void> {
    const picked = await vscode.window.showQuickPick(
        profiles.map(p => ({
            label: p.name,
            description: p.host,
            detail: p.clusterId ? `Cluster: ${p.clusterId}` : 'No cluster ID — will use serverless',
        })),
        { title: 'CatalystOps: Select ~/.databrickscfg Profile', placeHolder: 'Choose a profile' },
    );

    if (!picked) { return; }

    const profile = profiles.find(p => p.name === picked.label);
    if (!profile) { return; }

    await saveSettings(config, target, {
        host: profile.host,
        token: '',           // token lives in .databrickscfg, not VS Code settings
        authType: 'pat',
        profile: profile.name,
    });

    vscode.window.showInformationMessage(
        `CatalystOps: Connected using profile "${profile.name}" (${profile.host})`,
    );
}

// ─── Manual PAT flow ──────────────────────────────────────────────────────────

async function manualPatFlow(
    config: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget,
): Promise<void> {
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

    await saveSettings(config, target, {
        host,
        token,
        authType: 'pat',
        profile: '',
    });

    vscode.window.showInformationMessage('CatalystOps: Databricks connection configured.');
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

interface SettingsToSave {
    host: string;
    token: string;
    authType: 'pat' | 'azure-cli' | 'gcp-adc';
    profile: string;
}

async function saveSettings(
    config: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget,
    s: SettingsToSave,
): Promise<void> {
    await Promise.all([
        config.update('databricks.host', s.host, target),
        config.update('databricks.token', s.token, target),
        config.update('databricks.authType', s.authType, target),
        config.update('databricks.profile', s.profile, target),
    ]);
}
