/**
 * GCP Application Default Credentials (ADC) authentication for Databricks.
 * Uses `gcloud auth application-default print-access-token` to obtain a
 * short-lived Bearer token. Token is cached for 55 minutes.
 *
 * Setup: user must run `gcloud auth application-default login` once.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logDebug, logError } from '../logger';

const ADC_PATH = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');

interface TokenCache {
    token: string;
    expiresAt: number;
}

let cache: TokenCache | undefined;

/** Thrown when GCP ADC auth fails so callers can surface a targeted UX. */
export class GcpAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GcpAuthError';
    }
}

/** Returns true if the Databricks host is a GCP-hosted workspace. */
export function isGcpHost(host: string): boolean {
    return host.includes('.gcp.databricks.com');
}

/**
 * Verify that GCP Application Default Credentials are configured.
 * Returns the active gcloud account name, or throws GcpAuthError.
 */
export async function checkGcpAdcLogin(): Promise<{ account: string }> {
    if (!fs.existsSync(ADC_PATH)) {
        throw new GcpAuthError(
            'GCP Application Default Credentials not found. Run `gcloud auth application-default login` in a terminal first.',
        );
    }

    // Also verify gcloud is installed and get the active account name
    const account = await runGcloud(['config', 'get-value', 'account']).catch(() => '');
    return { account: account || 'unknown account' };
}

/**
 * Fetch a Databricks-scoped GCP ADC access token.
 * Caches the result for 55 minutes.
 */
export async function getGcpToken(): Promise<string> {
    const now = Date.now();
    if (cache && now < cache.expiresAt) {
        logDebug('gcpAuth: returning cached token');
        return cache.token;
    }

    logDebug('gcpAuth: fetching token via gcloud auth application-default print-access-token');

    const token = await runGcloud(['auth', 'application-default', 'print-access-token']);

    cache = { token, expiresAt: now + 55 * 60 * 1000 };
    logDebug('gcpAuth: token fetched and cached');
    return token;
}

/** Clears the in-memory token cache (e.g. after a 401). */
export function clearGcpTokenCache(): void {
    cache = undefined;
}

function runGcloud(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('gcloud', args, { timeout: 15000 }, (err: Error | null, stdout: string, stderr: string) => {
            if (err) {
                const msg = stderr?.trim() || err.message;
                logError(`gcpAuth: gcloud ${args[0]} failed: ${msg}`);
                if ((err as { code?: string }).code === 'ENOENT') {
                    reject(new GcpAuthError('Google Cloud CLI (`gcloud`) not found. Install it from https://cloud.google.com/sdk/docs/install'));
                } else if (msg.includes('not logged') || msg.includes('application-default login')) {
                    reject(new GcpAuthError('GCP Application Default Credentials expired. Run `gcloud auth application-default login` in a terminal first.'));
                } else {
                    reject(new GcpAuthError(`GCP CLI error: ${msg}`));
                }
                return;
            }
            resolve(stdout.trim());
        });
    });
}
