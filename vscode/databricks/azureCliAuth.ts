/**
 * Azure CLI authentication for Databricks.
 * Calls `az account get-access-token` to obtain a short-lived Bearer token
 * using the credentials from `az login`. The token is cached for 55 minutes.
 */

import { execFile } from 'child_process';
import { logDebug, logError } from '../logger';

/** Fixed Azure AD application ID for Azure Databricks — constant across all Azure environments. */
const DATABRICKS_RESOURCE_ID = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d';

/** Thrown when Azure CLI authentication fails so callers can surface a targeted UX. */
export class AzureCliAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AzureCliAuthError';
    }
}

interface TokenCache {
    token: string;
    expiresAt: number; // epoch ms
}

let cache: TokenCache | undefined;

/** Returns true if the Databricks host is an Azure-hosted workspace. */
export function isAzureHost(host: string): boolean {
    return host.includes('.azuredatabricks.net');
}

/**
 * Fetch a Databricks-scoped Azure AD token using the active `az login` session.
 * Caches the result for 55 minutes (tokens expire after ~60 minutes).
 * Throws if `az` is not installed or the user is not logged in.
 */
export async function getAzureCliToken(): Promise<string> {
    const now = Date.now();

    if (cache && now < cache.expiresAt) {
        logDebug('azureCliAuth: returning cached token');
        return cache.token;
    }

    logDebug('azureCliAuth: fetching token via az account get-access-token');

    const raw = await runAz([
        'account', 'get-access-token',
        '--resource', DATABRICKS_RESOURCE_ID,
        '--output', 'json',
    ]);

    let parsed: { accessToken?: string; tokenType?: string };
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Azure CLI returned unexpected output. Is `az` installed and up to date?');
    }

    if (!parsed.accessToken) {
        throw new Error('Azure CLI did not return an access token. Run `az login` and try again.');
    }

    cache = {
        token: parsed.accessToken,
        expiresAt: now + 55 * 60 * 1000,
    };

    logDebug('azureCliAuth: token fetched and cached');
    return cache.token;
}

/**
 * Verify that the user is currently logged in to Azure CLI.
 * Returns the signed-in account info, or throws with a helpful message.
 */
export async function checkAzureCliLogin(): Promise<{ name: string; user: string }> {
    const raw = await runAz(['account', 'show', '--output', 'json']);
    try {
        const account = JSON.parse(raw);
        return {
            name: account.name ?? account.id ?? 'unknown subscription',
            user: account.user?.name ?? account.user?.assignedIdentityInfo ?? 'unknown user',
        };
    } catch {
        throw new Error('Azure CLI is not logged in. Run `az login` in a terminal first.');
    }
}

/** Clears the in-memory token cache (e.g. after an auth error). */
export function clearAzureTokenCache(): void {
    cache = undefined;
}

export interface AzureWorkspace {
    name: string;
    resourceId: string;
    resourceGroup: string;
    location: string;
}

/**
 * List all Databricks workspaces in the current Azure subscription.
 */
export async function listAzureWorkspaces(): Promise<AzureWorkspace[]> {
    const raw = await runAz([
        'resource', 'list',
        '--resource-type', 'Microsoft.Databricks/workspaces',
        '--query', '[].{name:name,id:id,location:location,resourceGroup:resourceGroup}',
        '--output', 'json',
    ]);
    const items: Array<{ name: string; id: string; location: string; resourceGroup: string }> = JSON.parse(raw);
    return Array.isArray(items) ? items.map(w => ({
        name: w.name,
        resourceId: w.id,
        resourceGroup: w.resourceGroup,
        location: w.location,
    })) : [];
}

/**
 * Get the workspace URL (e.g. https://adb-xxx.azuredatabricks.net) for a workspace ARM resource ID.
 */
export async function getAzureWorkspaceUrl(resourceId: string): Promise<string> {
    const raw = await runAz([
        'resource', 'show',
        '--ids', resourceId,
        '--query', 'properties.workspaceUrl',
        '--output', 'tsv',
    ]);
    const url = raw.trim();
    return url.startsWith('https://') ? url : `https://${url}`;
}

function runAz(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('az', args, { timeout: 15000 }, (err: Error | null, stdout: string, stderr: string) => {
            if (err) {
                const msg = stderr?.trim() || err.message;
                logError(`azureCliAuth: az ${args[0]} failed: ${msg}`);
                if (msg.includes('not logged') || msg.includes('az login') || msg.includes('AADSTS')) {
                    reject(new Error('Not logged in to Azure. Run `az login` in a terminal first.'));
                } else if ((err as { code?: string }).code === 'ENOENT') {
                    reject(new Error('Azure CLI (`az`) not found. Install it from https://aka.ms/install-azure-cli'));
                } else {
                    reject(new Error(`Azure CLI error: ${msg}`));
                }
                return;
            }
            resolve(stdout.trim());
        });
    });
}
