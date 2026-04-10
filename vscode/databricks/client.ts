/**
 * HTTP client for Databricks REST API using Node.js built-in https module.
 * Zero runtime dependencies.
 */

import * as https from 'https';
import * as url from 'url';
import { logDebug } from '../logger';
import { isAzureHost, getAzureCliToken, clearAzureTokenCache, AzureCliAuthError } from './azureCliAuth';
import { isGcpHost, getGcpToken, clearGcpTokenCache, GcpAuthError } from './gcpAuth';
import { getOAuthToken, clearOAuthTokenCache, OAuthU2mError } from './oauthU2mAuth';

export interface RequestOptions {
    host: string;
    token: string;
    authType?: 'pat' | 'azure-cli' | 'gcp-adc' | 'oauth-u2m';
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
    /** Send body as raw bytes with the given Content-Type instead of JSON. */
    rawBody?: Buffer;
    rawContentType?: string;
    timeoutMs?: number;
}

export interface ApiResponse<T = unknown> {
    statusCode: number;
    data: T;
}

/**
 * Build an equivalent curl command for logging/debugging.
 * Redacts the token and truncates large bodies (e.g. the script payload).
 */
function toCurl(options: RequestOptions, bodyStr: string | undefined): string {
    const fullUrl = new URL(options.path, options.host).toString();
    const redacted = options.token.length > 8
        ? `${options.token.substring(0, 4)}${'*'.repeat(options.token.length - 4)}`
        : '****';

    const parts = [
        `curl -X ${options.method}`,
        `  '${fullUrl}'`,
        `  -H 'Authorization: Bearer ${redacted}'`,
        `  -H 'Content-Type: application/json'`,
    ];

    if (bodyStr) {
        // Replace the 'command' field (full Python script) with a size hint
        let display = bodyStr;
        try {
            const obj = JSON.parse(bodyStr);
            if (typeof obj.command === 'string') {
                obj.command = `<script: ${obj.command.length} chars>`;
                display = JSON.stringify(obj);
            }
        } catch { /* leave as-is */ }
        parts.push(`  -d '${display}'`);
    }

    return parts.join(' \\\n');
}

/**
 * Session-level auth type override.
 * Commands set this via setSessionAuthType() before making API calls so that
 * all apiRequest() calls in a command inherit the correct auth type without
 * requiring changes to every API function signature.
 */
let _sessionAuthType: string | undefined;

export function setSessionAuthType(authType: string | undefined): void {
    _sessionAuthType = authType;
}

/**
 * Make an authenticated request to the Databricks REST API.
 * If token is empty and the host is an Azure workspace, fetches a token via Azure CLI automatically.
 */
export async function apiRequest<T = unknown>(options: RequestOptions): Promise<ApiResponse<T>> {
    let token = options.token;
    const authType = options.authType ?? _sessionAuthType;

    if (authType === 'oauth-u2m') {
        try {
            token = await getOAuthToken(options.host);
        } catch (err) {
            throw new OAuthU2mError(err instanceof Error ? err.message : String(err));
        }
    } else if (!token && isAzureHost(options.host)) {
        try {
            token = await getAzureCliToken();
        } catch (err) {
            throw new AzureCliAuthError(err instanceof Error ? err.message : String(err));
        }
    } else if (!token && isGcpHost(options.host)) {
        try {
            token = await getGcpToken();
        } catch (err) {
            throw new GcpAuthError(err instanceof Error ? err.message : String(err));
        }
    }

    return makeRequest<T>({ ...options, token });
}

function makeRequest<T = unknown>(options: RequestOptions): Promise<ApiResponse<T>> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(options.path, options.host);
        const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
        const rawBody = options.rawBody;
        const token = options.token;

        logDebug(toCurl(options, bodyStr));

        const contentType = rawBody
            ? (options.rawContentType ?? 'application/octet-stream')
            : 'application/json';
        const bodyBytes = rawBody ?? (bodyStr ? Buffer.from(bodyStr, 'utf-8') : undefined);

        const reqOptions: https.RequestOptions = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + parsed.search,
            method: options.method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': contentType,
                'User-Agent': 'CatalystOps-VSCode/0.1.0',
            },
            timeout: options.timeoutMs ?? 30000,
        };

        if (bodyBytes) {
            (reqOptions.headers as Record<string, string>)['Content-Length'] = bodyBytes.length.toString();
        }

        const req = https.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];

            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                // Clear auth token caches on 401 so the next call re-fetches
                if (res.statusCode === 401) { clearAzureTokenCache(); clearGcpTokenCache(); clearOAuthTokenCache(options.host); }
                try {
                    const data = raw ? JSON.parse(raw) : {};
                    resolve({ statusCode: res.statusCode ?? 0, data: data as T });
                } catch {
                    resolve({ statusCode: res.statusCode ?? 0, data: raw as unknown as T });
                }
            });
        });

        req.on('error', (err) => reject(new Error(`Databricks API request failed: ${err.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Databricks API request timed out'));
        });

        if (bodyBytes) {
            req.write(bodyBytes);
        }
        req.end();
    });
}
