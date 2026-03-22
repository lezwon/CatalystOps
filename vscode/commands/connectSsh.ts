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
import { listClusters, startCluster, stopCluster, getClusterState, getClusterSpec, editCluster, restartCluster, getCurrentUserEmail, ensureSshSecretScope, ClusterInfo, ClusterState } from '../databricks/clustersApi';
import { ClustersTreeDataProvider } from '../views/clustersTreeView';
import { logDebug, logError } from '../logger';
import { sendEvent } from '../telemetry';

// Minimum Databricks CLI version required for SSH setup
const MIN_CLI_MAJOR = 0;
const MIN_CLI_MINOR = 269;

export async function clearSshAlias(
    cluster: ClusterInfo,
    context: vscode.ExtensionContext,
): Promise<void> {
    const aliasCache = context.globalState.get<Record<string, string>>(ALIAS_CACHE_KEY, {});
    const existing = aliasCache[cluster.clusterId];
    if (!existing) {
        void vscode.window.showInformationMessage(`CatalystOps: No cached SSH alias for "${cluster.clusterName}".`);
        return;
    }
    delete aliasCache[cluster.clusterId];
    await context.globalState.update(ALIAS_CACHE_KEY, aliasCache);
    logDebug(`connectSsh: cleared cached alias "${existing}" for cluster ${cluster.clusterId}`);
    void vscode.window.showInformationMessage(
        `CatalystOps: Cleared SSH alias "${existing}" for "${cluster.clusterName}". Next connect will re-run setup.`,
    );
}

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS  = 10 * 60 * 1_000; // 10 minutes

export async function startClusterCommand(
    cluster: ClusterInfo,
    provider: ClustersTreeDataProvider,
): Promise<void> {
    const config = getConnectionConfig();
    if (!config) {
        void vscode.window.showErrorMessage('CatalystOps: Databricks not configured. Run "Configure Connection" first.');
        return;
    }
    try {
        await startCluster(config.host, config.token, cluster.clusterId);
        sendEvent('cluster/start', { clusterState: cluster.state });
        logDebug(`connectSsh: start requested for ${cluster.clusterId}, beginning state poll`);

        // Poll state every 5 s and update the tree live until the cluster is running or errors.
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        const poll = async (): Promise<void> => {
            if (Date.now() > deadline) { return; }
            try {
                const state = await getClusterState(config.host, config.token, cluster.clusterId);
                provider.updateClusterState(cluster.clusterId, state);
                logDebug(`connectSsh: poll state=${state} for ${cluster.clusterId}`);
                if (state === 'RUNNING' || state === 'ERROR' || state === 'TERMINATED') { return; }
                await sleep(POLL_INTERVAL_MS);
                return poll();
            } catch {
                // network hiccup — retry
                await sleep(POLL_INTERVAL_MS);
                return poll();
            }
        };
        void poll();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`CatalystOps: Failed to start cluster: ${message}`);
    }
}

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

const MIN_SSH_SPARK_VERSION = 17;
const RECOMMENDED_SPARK_VERSION = '17.3.x-scala2.13';

/**
 * Offer to auto-fix a cluster's access mode (and optionally Spark version) when
 * `databricks ssh setup` rejects it. Restarts the cluster, waits for RUNNING,
 * then retries setup.
 */
async function fixClusterAndRetry(
    cluster: ClusterInfo,
    config: import('../config/settings').DatabricksConnectionConfig,
    profile: string,
    preferredAlias: string,
    provider: ClustersTreeDataProvider,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    aliasCache: Record<string, string>,
    context: vscode.ExtensionContext,
): Promise<void> {
    // Fetch the full spec to inspect the current Spark version.
    let clusterSpec: Record<string, unknown> = {};
    let currentSpark = cluster.sparkVersion;
    try {
        const details = await getClusterSpec(config.host, config.token, cluster.clusterId);
        clusterSpec = details.spec;
        currentSpark = details.sparkVersion || currentSpark;
    } catch {
        // proceed with what we have
    }

    const majorVersion = parseInt((currentSpark ?? '').split('.')[0], 10);
    const sparkNeedsUpgrade = isNaN(majorVersion) || majorVersion < MIN_SSH_SPARK_VERSION;
    const sparkLabel = sparkNeedsUpgrade
        ? ` and upgrade Spark to ${RECOMMENDED_SPARK_VERSION}`
        : '';

    const action = await vscode.window.showWarningMessage(
        `CatalystOps: Cluster "${cluster.clusterName}" needs Single User access mode for SSH.` +
        `${sparkNeedsUpgrade ? ` Its Spark version (${currentSpark}) is also below 17.0.` : ''}` +
        ` Fix${sparkLabel} and restart now?`,
        { modal: true },
        'Fix & Restart',
        'Open Cluster Settings',
    );

    if (action === 'Open Cluster Settings') {
        void vscode.env.openExternal(vscode.Uri.parse(
            `${config.host}#setting/clusters/${cluster.clusterId}/configuration`,
        ));
        return;
    }
    if (action !== 'Fix & Restart') { return; }

    // Apply fixes
    progress.report({ message: 'Updating cluster settings…' });
    const updatedSpec: Record<string, unknown> = {
        ...clusterSpec,
        data_security_mode: 'SINGLE_USER',
        ...(sparkNeedsUpgrade ? { spark_version: RECOMMENDED_SPARK_VERSION } : {}),
    };
    try {
        await editCluster(config.host, config.token, cluster.clusterId, updatedSpec);
        logDebug(`connectSsh: cluster edit applied (SINGLE_USER${sparkNeedsUpgrade ? ', spark=' + RECOMMENDED_SPARK_VERSION : ''})`);
    } catch (editErr) {
        void vscode.window.showErrorMessage(`CatalystOps: Failed to update cluster: ${editErr}`);
        return;
    }

    // Restart
    progress.report({ message: 'Restarting cluster…' });
    try {
        await restartCluster(config.host, config.token, cluster.clusterId);
    } catch {
        // If not running, start instead
        await startCluster(config.host, config.token, cluster.clusterId);
    }

    // Poll until RUNNING
    const deadline = Date.now() + 10 * 60 * 1_000;
    let state: ClusterState = 'PENDING';
    provider.updateClusterState(cluster.clusterId, 'PENDING');
    while (state !== 'RUNNING' && state !== 'ERROR' && state !== 'TERMINATED') {
        if (Date.now() > deadline) {
            void vscode.window.showWarningMessage(
                `CatalystOps: Cluster is still restarting. Try connecting again once it's Running.`,
            );
            return;
        }
        progress.report({ message: `Waiting for cluster to restart (${state.toLowerCase()})…` });
        await sleep(5_000);
        try {
            state = await getClusterState(config.host, config.token, cluster.clusterId);
            provider.updateClusterState(cluster.clusterId, state);
        } catch { /* keep polling */ }
    }
    if (state !== 'RUNNING') {
        void vscode.window.showErrorMessage(`CatalystOps: Cluster failed to restart (state: ${state}).`);
        return;
    }

    // Retry ssh setup with the fixed cluster
    progress.report({ message: 'Retrying SSH setup…' });
    const retryResult = await runCommand('databricks', [
        'ssh', 'setup', '--name', preferredAlias,
        '--cluster', cluster.clusterId,
        '--profile', profile,
        '--auto-start-cluster', '--shutdown-delay', '30m',
    ]);
    if (retryResult.code !== 0) {
        void vscode.window.showErrorMessage(
            `CatalystOps: SSH setup still failed after fix: ${(retryResult.stderr || retryResult.stdout).substring(0, 200)}`,
        );
        return;
    }
    const newConfigs = listDatabricksSshConfigs();
    const created = findConfigForCluster(cluster.clusterId, newConfigs);
    if (created) {
        aliasCache[cluster.clusterId] = created;
        await context.globalState.update(ALIAS_CACHE_KEY, aliasCache);
        logDebug(`connectSsh: post-fix SSH alias "${created}" cached`);
        sendEvent('cluster/ssh_fixed_and_connected');
        await openRemoteSshWindow(created, cluster.clusterName);
    } else {
        void vscode.window.showErrorMessage(`CatalystOps: SSH setup succeeded but no config found for ${cluster.clusterId}.`);
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
    provider: ClustersTreeDataProvider,
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
            // Step 1: Ensure cluster is running before attempting SSH setup/connect
            const CLUSTER_START_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes
            const isActive = (s: string) => s === 'RUNNING' || s === 'PENDING' || s === 'RESTARTING' || s === 'RESIZING';

            if (!isActive(cluster.state)) {
                progress.report({ message: 'Starting cluster…', increment: 10 });
                try {
                    await startCluster(config.host, config.token, cluster.clusterId);
                    logDebug(`connectSsh: start requested for ${cluster.clusterId}, polling for RUNNING`);
                } catch (startErr) {
                    // Cluster may already be starting — ignore and poll anyway
                    logDebug(`connectSsh: start call error (may already be starting): ${startErr}`);
                }

                const deadline = Date.now() + CLUSTER_START_TIMEOUT_MS;
                // Treat as PENDING immediately — cluster.state is still TERMINATED
                // from the tree cache and the while loop would exit early otherwise.
                let state: ClusterState = 'PENDING';
                provider.updateClusterState(cluster.clusterId, 'PENDING');
                while (state !== 'RUNNING' && state !== 'ERROR' && state !== 'TERMINATED') {
                    if (Date.now() > deadline) {
                        void vscode.window.showWarningMessage(
                            `CatalystOps: Cluster "${cluster.clusterName}" is still starting. ` +
                            `Try connecting again once it reaches Running state.`,
                        );
                        provider.updateClusterState(cluster.clusterId, state);
                        return;
                    }
                    progress.report({ message: `Waiting for cluster to start (${state.toLowerCase()})…` });
                    await sleep(5_000);
                    try {
                        state = await getClusterState(config.host, config.token, cluster.clusterId);
                        provider.updateClusterState(cluster.clusterId, state);
                        logDebug(`connectSsh: cluster state=${state}`);
                    } catch {
                        // network hiccup — keep polling
                    }
                }

                if (state !== 'RUNNING') {
                    void vscode.window.showErrorMessage(
                        `CatalystOps: Cluster "${cluster.clusterName}" failed to start (state: ${state}).`,
                    );
                    return;
                }
                progress.report({ message: 'Cluster running…', increment: 10 });
            }

            // Step 2: Resolve SSH alias
            // Priority: cached > existing Databricks config > run setup
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
                // Sanitize: lowercase, spaces → underscore, drop anything not alphanumeric/hyphen/underscore.
                // This avoids shell quoting issues (e.g. apostrophes in cluster names).
                const preferredAlias = cluster.clusterName
                    .toLowerCase()
                    .replace(/\s+/g, '_')
                    .replace(/[^a-z0-9_-]/g, '')
                    .replace(/^[-_]+|[-_]+$/g, '') // trim leading/trailing separators
                    || `cluster-${cluster.clusterId.slice(0, 8)}`; // fallback if name is all special chars

                // Check if the CLI already set this up for THIS specific cluster.
                // Match by cluster ID inside the file content — not just by alias name —
                // so selecting a different cluster never reuses the wrong config.
                const existingDatabricksConfigs = listDatabricksSshConfigs();
                const alreadySetUp = findConfigForCluster(cluster.clusterId, existingDatabricksConfigs);

                if (alreadySetUp) {
                    logDebug(`connectSsh: found existing Databricks SSH config "${alreadySetUp}" for cluster ${cluster.clusterId}`);
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

                    if (setupResult.code !== 0) {
                        const errText = (setupResult.stderr || setupResult.stdout).trim();
                        if (/not allowed in your current.*(plan|tier)|ssh.*not.*supported|plan.*does not (include|support).*ssh/i.test(errText)) {
                            void vscode.window.showErrorMessage(
                                `CatalystOps: SSH is not available in this Databricks workspace's current plan. ` +
                                `Contact your Databricks account team to enable it, or use a workspace where SSH is included.`,
                            );
                        } else if (/dedicated access mode|single.?user/i.test(errText)) {
                            await fixClusterAndRetry(cluster, config, profile, preferredAlias, provider, progress, aliasCache, context);
                        } else {
                            void vscode.window.showErrorMessage(
                                `CatalystOps: databricks ssh setup failed (exit ${setupResult.code}).\n${errText.substring(0, 300)}\n\n` +
                                `Run manually: databricks ssh setup --name ${preferredAlias} --cluster ${cluster.clusterId} --profile ${profile}`,
                            );
                        }
                        return;
                    }

                    // Find the newly created config by reading file contents — the CLI may have
                    // used a slightly different name than preferredAlias.
                    const newConfigs = listDatabricksSshConfigs();
                    const created = findConfigForCluster(cluster.clusterId, newConfigs);

                    if (created) {
                        logDebug(`connectSsh: CLI created config "${created}" for cluster ${cluster.clusterId}`);
                        sshAlias = created;
                    } else {
                        void vscode.window.showErrorMessage(
                            `CatalystOps: SSH setup succeeded but no config was found for cluster ${cluster.clusterId}.\n` +
                            `Run manually: databricks ssh setup --name ${preferredAlias} --cluster ${cluster.clusterId} --profile ${profile}`,
                        );
                        return;
                    }
                }

                aliasCache[cluster.clusterId] = sshAlias;
                await context.globalState.update(ALIAS_CACHE_KEY, aliasCache);
                logDebug(`connectSsh: cached alias "${sshAlias}" for cluster ${cluster.clusterId}`);
            } else {
                logDebug(`connectSsh: using cached alias "${sshAlias}"`);
            }

            // Step 3: Pre-create the SSH secrets scope so `databricks ssh connect` doesn't fail
            // on Standard-tier workspaces that block scope creation without initial_manage_principal.
            // Scope name: {email}-{clusterId}-ssh-tunnel-keys (derived from CLI debug traces).
            // Also delete any stale key file we may have generated manually for this cluster.
            try {
                const email = await getCurrentUserEmail(config.host, config.token);
                if (email) {
                    await ensureSshSecretScope(config.host, config.token, email, cluster.clusterId);
                    logDebug(`connectSsh: ensured SSH secret scope for ${email} / ${cluster.clusterId}`);
                }
            } catch (scopeErr) {
                logDebug(`connectSsh: scope pre-create warning: ${scopeErr}`);
            }
            // Remove stale manually-generated key so the CLI can write the correct one.
            const staleKey = path.join(os.homedir(), '.databricks', 'ssh-tunnel-keys', cluster.clusterId);
            for (const f of [staleKey, `${staleKey}.pub`]) {
                if (fs.existsSync(f)) {
                    fs.rmSync(f);
                    logDebug(`connectSsh: removed stale key file ${f}`);
                }
            }

            // Step 4: Ensure Remote SSH connect timeout is long enough for Databricks clusters.
            // Databricks clusters can take 2–3 minutes to start an SSH server after the job
            // is submitted.  The VS Code default (15 s) is too short.
            const remoteSshConfig = vscode.workspace.getConfiguration('remote.SSH');
            const currentTimeout = remoteSshConfig.get<number>('connectTimeout', 15);
            if (currentTimeout < 180) {
                await remoteSshConfig.update('connectTimeout', 180, vscode.ConfigurationTarget.Global);
                logDebug(`connectSsh: raised remote.SSH.connectTimeout from ${currentTimeout}s to 180s`);
            }

            // Step 4: Open VS Code Remote SSH
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

/**
 * Find the SSH alias (config file name) that actually references a given cluster ID.
 * Reads file contents so we match by cluster ID, not just alias name — prevents
 * connecting to the wrong cluster when two clusters share a similar name.
 */
function findConfigForCluster(clusterId: string, aliases: string[]): string | undefined {
    for (const alias of aliases) {
        try {
            const content = fs.readFileSync(path.join(DATABRICKS_SSH_CONFIGS_DIR, alias), 'utf-8');
            if (content.includes(clusterId)) { return alias; }
        } catch {
            // unreadable file — skip
        }
    }
    return undefined;
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
