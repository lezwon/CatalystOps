/**
 * One-click Databricks SSH via VS Code Remote SSH.
 *
 * Flow:
 *  1. Verify Databricks CLI ≥ 0.200 is installed
 *  2. Verify an SSH key exists (offer to generate ed25519 if not)
 *  3. If cluster is TERMINATED, offer to start it and wait
 *  4. Run `databricks ssh setup --cluster <id> --name <alias>`
 *     which writes a ProxyCommand entry to ~/.ssh/config
 *  5. Open VS Code Remote SSH window for that alias
 *
 * Requires: Databricks CLI ≥ 0.200, VS Code Remote SSH extension
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getConnectionConfig } from '../config/settings';
import { listClusters, stopCluster, ClusterInfo } from '../databricks/clustersApi';
import { ClustersTreeDataProvider } from '../views/clustersTreeView';
import { logDebug, logError } from '../logger';
import { sendEvent } from '../telemetry';

// Minimum Databricks CLI version required for SSH setup
const MIN_CLI_MAJOR = 0;
const MIN_CLI_MINOR = 269;

export async function stopClusterCommand(
    cluster: ClusterInfo,
    provider: ClustersTreeDataProvider,
): Promise<void> {
    const config = getConnectionConfig();
    if (!config) {
        void vscode.window.showErrorMessage('CatalystOps: Databricks not configured.');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Stop cluster "${cluster.clusterName}"? Running jobs will be terminated.`,
        { modal: true },
        'Stop Cluster',
    );
    if (confirm !== 'Stop Cluster') { return; }

    try {
        await stopCluster(config.host, config.token, cluster.clusterId);
        sendEvent('cluster/stop', { clusterState: cluster.state });
        void vscode.window.showInformationMessage(`Stopping "${cluster.clusterName}"…`);
        // Refresh after a short delay so the state change is visible
        setTimeout(() => void refreshClustersList(provider), 3000);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`CatalystOps: Failed to stop cluster: ${message}`);
    }
}

export async function refreshClustersList(provider: ClustersTreeDataProvider): Promise<void> {
    const config = getConnectionConfig();
    if (!config) {
        provider.setError('Databricks not configured. Run "CatalystOps: Configure Connection" first.');
        return;
    }

    provider.setLoading(true);
    sendEvent('clusters/refresh_start');

    try {
        const clusters = await listClusters(config.host, config.token);
        provider.setClusters(clusters);
        sendEvent('clusters/refresh_complete', { count: String(clusters.length) });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        provider.setError(message);
        sendEvent('clusters/refresh_failed', { error: message.substring(0, 200) });
    }
}

const ALIAS_CACHE_KEY = 'catalystops.ssh.aliasCache';
// Directory where `databricks ssh setup` stores per-host config files
const DATABRICKS_SSH_CONFIGS_DIR = path.join(os.homedir(), '.databricks', 'ssh-tunnel-configs');

export async function connectClusterSsh(
    cluster: ClusterInfo,
    context: vscode.ExtensionContext,
): Promise<void> {
    const config = getConnectionConfig();
    if (!config) {
        void vscode.window.showErrorMessage('CatalystOps: Databricks not configured. Run "Configure Connection" first.');
        return;
    }

    // Check CLI before showing progress
    const cliVersion = await getDatabricksCLIVersion();
    if (!cliVersion) {
        void vscode.window.showErrorMessage(
            'CatalystOps: Databricks CLI not found.',
            'Install Databricks CLI',
        ).then(action => {
            if (action === 'Install Databricks CLI') {
                void vscode.env.openExternal(vscode.Uri.parse('https://docs.databricks.com/dev-tools/cli/install.html'));
            }
        });
        return;
    }
    if (!isVersionSufficient(cliVersion)) {
        void vscode.window.showErrorMessage(
            `CatalystOps: Databricks CLI ${cliVersion} is too old (need ≥ ${MIN_CLI_MAJOR}.${MIN_CLI_MINOR}.0). ` +
            'Run: curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sudo sh',
        );
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `CatalystOps: Connecting to "${cluster.clusterName}" via SSH`,
        cancellable: false,
    }, async (progress) => {
        try {
            // Step 1: Resolve SSH alias
            // Priority: cached > existing Databricks config > run setup > QuickPick
            progress.report({ message: 'Resolving SSH alias…', increment: 15 });

            // Clean up any stale broken entry our old code may have written
            removeSshConfigEntry(`databricks-${cluster.clusterId}`);

            const aliasCache = context.globalState.get<Record<string, string>>(ALIAS_CACHE_KEY, {});
            let cachedAlias = aliasCache[cluster.clusterId];

            // Invalidate cache if the alias no longer exists in ~/.databricks/ssh-tunnel-configs/
            // (catches stale entries written by old extension code)
            if (cachedAlias) {
                const configs = listDatabricksSshConfigs();
                const valid = configs.includes(cachedAlias) || readSshHosts().includes(cachedAlias);
                if (!valid) {
                    logDebug(`connectSsh: cached alias "${cachedAlias}" not found in configs — clearing cache`);
                    delete aliasCache[cluster.clusterId];
                    await context.globalState.update(ALIAS_CACHE_KEY, aliasCache);
                    cachedAlias = '';
                }
            }

            let sshAlias = cachedAlias || '';

            if (!sshAlias) {
                const vsConfig = vscode.workspace.getConfiguration('catalystops');
                const profile = vsConfig.get<string>('databricks.profile', 'DEFAULT');
                const shutdownDelay = vsConfig.get<string>('ssh.shutdownDelay', '30m');
                const preferredAlias = cluster.clusterName.replace(/\s+/g, '_').toLowerCase();

                // Check if the CLI already set this up (config exists in ~/.databricks/ssh-tunnel-configs/)
                const existingDatabricksConfigs = listDatabricksSshConfigs();
                const alreadySetUp = existingDatabricksConfigs.find(
                    n => n === preferredAlias || n.includes(cluster.clusterId),
                );

                if (alreadySetUp) {
                    logDebug(`connectSsh: found existing Databricks SSH config "${alreadySetUp}"`);
                    sshAlias = alreadySetUp;
                } else {
                    // Run databricks ssh setup — it writes ~/.databricks/ssh-tunnel-configs/<name>
                    // and adds an Include to ~/.ssh/config
                    progress.report({ message: 'Running databricks ssh setup…', increment: 30 });
                    const setupResult = await runCommand('databricks', [
                        'ssh', 'setup',
                        '--name', preferredAlias,
                        '--cluster', cluster.clusterId,
                        '--profile', profile,
                        '--auto-start-cluster',
                        '--shutdown-delay', shutdownDelay,
                    ]);
                    logDebug(`connectSsh: setup code=${setupResult.code} out=${setupResult.stdout.substring(0, 200)} err=${setupResult.stderr.substring(0, 300)}`);

                    // Check ~/.databricks/ssh-tunnel-configs/ for the new entry
                    const newConfigs = listDatabricksSshConfigs();
                    const created = newConfigs.find(n => n === preferredAlias || n.includes(cluster.clusterId));

                    if (created) {
                        logDebug(`connectSsh: CLI created config "${created}"`);
                        sshAlias = created;
                    } else {
                        // Setup may have failed or used a different name — show all known aliases
                        const choices = newConfigs.length > 0 ? newConfigs : readSshHosts();
                        if (choices.length === 0) {
                            void vscode.window.showErrorMessage(
                                `CatalystOps: Could not find an SSH config after setup.\n` +
                                `Run manually: databricks ssh setup --name <alias> --cluster ${cluster.clusterId} --profile ${profile}`,
                            );
                            return;
                        }
                        const picked = await vscode.window.showQuickPick(choices, {
                            title: `Which SSH host connects to "${cluster.clusterName}"?`,
                            placeHolder: 'Select the alias from ~/.databricks/ssh-tunnel-configs or ~/.ssh/config',
                        });
                        if (!picked) { return; }
                        sshAlias = picked;
                    }
                }

                aliasCache[cluster.clusterId] = sshAlias;
                await context.globalState.update(ALIAS_CACHE_KEY, aliasCache);
                logDebug(`connectSsh: cached alias "${sshAlias}" for cluster ${cluster.clusterId}`);
            } else {
                logDebug(`connectSsh: using cached alias "${sshAlias}"`);
            }

            // Step 2: Open VS Code Remote SSH
            progress.report({ message: `Opening "${sshAlias}"…`, increment: 55 });
            const opened = await openRemoteSshWindow(sshAlias, cluster.clusterName);

            sendEvent('cluster/ssh_connect', {
                clusterState: cluster.state,
                openedRemote: String(opened),
            });

        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`connectClusterSsh failed: ${message}`);
            sendEvent('cluster/ssh_failed', { error: message.substring(0, 200) });
            void vscode.window.showErrorMessage(`CatalystOps: SSH connection failed: ${message}`);
        }
    });
}

/** List aliases in ~/.databricks/ssh-tunnel-configs/ (where the CLI stores its SSH configs). */
function listDatabricksSshConfigs(): string[] {
    if (!fs.existsSync(DATABRICKS_SSH_CONFIGS_DIR)) { return []; }
    return fs.readdirSync(DATABRICKS_SSH_CONFIGS_DIR).filter(f => {
        const full = path.join(DATABRICKS_SSH_CONFIGS_DIR, f);
        return fs.statSync(full).isFile();
    });
}

/** Remove a Host block from ~/.ssh/config by alias (cleans up stale entries). */
function removeSshConfigEntry(alias: string): void {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(configPath)) { return; }
    const original = fs.readFileSync(configPath, 'utf-8');
    // Match: optional blank line, "Host <alias>\n", then indented lines until next Host or EOF
    const pattern = new RegExp(
        `\\n?^Host ${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$[\\s\\S]*?(?=\\n^Host |\\n^Match |$)`,
        'gm',
    );
    const cleaned = original.replace(pattern, '');
    if (cleaned !== original) {
        fs.writeFileSync(configPath, cleaned, { mode: 0o600 });
        logDebug(`connectSsh: removed stale ~/.ssh/config entry for "${alias}"`);
    }
}

/** Returns the installed Databricks CLI version string, or undefined if not found. */
async function getDatabricksCLIVersion(): Promise<string | undefined> {
    const result = await runCommand('databricks', ['--version']);
    if (result.code !== 0 && result.code !== 127) {
        // Some CLIs write version to stderr
        const text = (result.stdout + result.stderr).trim();
        const match = text.match(/(\d+\.\d+\.\d+)/);
        return match ? match[1] : undefined;
    }
    if (result.code === 127) { return undefined; } // not found

    const text = (result.stdout + result.stderr).trim();
    const match = text.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : undefined;
}

function isVersionSufficient(version: string): boolean {
    const parts = version.split('.').map(Number);
    const [major, minor] = parts;
    if (major > MIN_CLI_MAJOR) { return true; }
    if (major === MIN_CLI_MAJOR && minor >= MIN_CLI_MINOR) { return true; }
    return false;
}



/** Open VS Code Remote SSH. Returns true if successful, false if extension not available. */
async function openRemoteSshWindow(sshAlias: string, clusterName: string): Promise<boolean> {
    // Primary: open via remote URI (most reliable across VS Code versions)
    try {
        const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${sshAlias}/`);
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        return true;
    } catch {
        // Fall through to extension command
    }

    // Secondary: Remote SSH extension command
    try {
        await vscode.commands.executeCommand('remote-ssh.openEmptyWindow', { host: sshAlias });
        return true;
    } catch {
        // Extension not installed
    }

    const choice = await vscode.window.showInformationMessage(
        `SSH configured for "${clusterName}" (alias: ${sshAlias}). ` +
        'Install "Remote - SSH" to connect from VS Code, or use a terminal.',
        'Open Terminal',
        'Install Remote SSH',
    );
    if (choice === 'Install Remote SSH') {
        await vscode.commands.executeCommand('extension.open', 'ms-vscode-remote.remote-ssh');
    } else if (choice === 'Open Terminal') {
        const t = vscode.window.createTerminal({ name: `SSH: ${clusterName}` });
        t.sendText(`ssh ${sshAlias}`);
        t.show();
    }
    return false;
}

/** Read all Host entries currently in ~/.ssh/config. */
function readSshHosts(): string[] {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(configPath)) { return []; }
    const content = fs.readFileSync(configPath, 'utf-8');
    const hosts: string[] = [];
    for (const line of content.split('\n')) {
        const m = line.match(/^Host\s+(\S+)/);
        if (m && m[1] !== '*') { hosts.push(m[1]); }
    }
    return hosts;
}


function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise(resolve => {
        // Use shell: true so the command is resolved through the user's shell PATH
        // (VS Code extensions don't inherit the full shell environment on macOS/Linux)
        const proc = spawn(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
            env: {
                ...process.env,
                // Augment PATH with common install locations for Homebrew, pip, cargo, etc.
                PATH: [
                    process.env.PATH ?? '',
                    '/opt/homebrew/bin',
                    '/usr/local/bin',
                    `${os.homedir()}/.local/bin`,
                    `${os.homedir()}/.databricks/bin`,
                    `${os.homedir()}/bin`,
                ].filter(Boolean).join(':'),
            },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', code => resolve({ stdout, stderr, code: code ?? 1 }));
        proc.on('error', () => resolve({ stdout: '', stderr: `Not found: ${cmd}`, code: 127 }));
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
