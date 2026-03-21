/**
 * Databricks SSH tunnel execution.
 *
 * Runs analysis scripts on Databricks cluster compute via SSH.
 * Requires:
 *   - Databricks CLI ≥ 0.269 installed
 *   - SSH connection configured: `databricks ssh setup --name <name>`
 *   - Cluster running Databricks Runtime 17+ with Unity Catalog
 *
 * The cluster driver node exposes a full PySpark environment over SSH,
 * so the same analysis scripts used in cluster/serverless mode work unchanged.
 */

import { spawn } from 'child_process';
import { logDebug } from '../logger';

/**
 * Verify that the SSH connection is reachable.
 * Returns true if the connection responds within 5 s.
 */
export async function checkSshAvailable(connectionName: string): Promise<boolean> {
    return new Promise(resolve => {
        const proc = spawn('ssh', [
            '-o', 'ConnectTimeout=5',
            '-o', 'BatchMode=yes',      // never prompt for password
            '-o', 'StrictHostKeyChecking=no',
            connectionName, 'echo', 'ok',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.on('close', (code) => resolve(code === 0 && stdout.trim() === 'ok'));
        proc.on('error', () => resolve(false));
    });
}

/**
 * Execute a Python script on the Databricks cluster via SSH.
 * The script is piped to `python3` on stdin — the cluster driver has
 * a full PySpark environment available.
 *
 * @param connectionName  Name from `databricks ssh setup --name <name>`
 * @param script          Python source to execute
 * @param timeoutMs       Milliseconds before aborting (default 5 min)
 * @returns               Combined stdout from the remote process
 */
export async function executeViaSsh(
    connectionName: string,
    script: string,
    timeoutMs: number = 300_000,
): Promise<string> {
    return new Promise((resolve, reject) => {
        logDebug(`SSH exec: ssh ${connectionName} python3 (<${script.length} chars>)`);

        const proc = spawn('ssh', [
            '-o', 'ConnectTimeout=10',
            '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=no',
            connectionName, 'python3',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        let done = false;

        const timer = setTimeout(() => {
            if (done) { return; }
            done = true;
            proc.kill('SIGTERM');
            reject(new Error(`SSH execution timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(
                    `SSH execution failed (exit ${code}):\n${stderr.substring(0, 500)}`,
                ));
            }
        });

        proc.on('error', (err) => {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            reject(new Error(
                `Failed to spawn SSH process: ${err.message}. ` +
                `Is OpenSSH installed and is "${connectionName}" configured via "databricks ssh setup"?`,
            ));
        });

        // Write script to remote python3 via stdin
        proc.stdin.write(script, 'utf-8');
        proc.stdin.end();
    });
}
