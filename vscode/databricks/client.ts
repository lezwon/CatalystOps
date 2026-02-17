/**
 * HTTP client for Databricks REST API using Node.js built-in https module.
 * Zero runtime dependencies.
 */

import * as https from 'https';
import * as url from 'url';

export interface RequestOptions {
    host: string;
    token: string;
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
    timeoutMs?: number;
}

export interface ApiResponse<T = unknown> {
    statusCode: number;
    data: T;
}

/**
 * Make an authenticated request to the Databricks REST API.
 */
export function apiRequest<T = unknown>(options: RequestOptions): Promise<ApiResponse<T>> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(options.path, options.host);
        const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

        const reqOptions: https.RequestOptions = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + parsed.search,
            method: options.method,
            headers: {
                'Authorization': `Bearer ${options.token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'CatalystOps-VSCode/0.1.0',
            },
            timeout: options.timeoutMs ?? 30000,
        };

        if (bodyStr) {
            (reqOptions.headers as Record<string, string>)['Content-Length'] = Buffer.byteLength(bodyStr).toString();
        }

        const req = https.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];

            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                try {
                    const data = raw ? JSON.parse(raw) : {};
                    resolve({ statusCode: res.statusCode ?? 0, data: data as T });
                } catch {
                    reject(new Error(`Failed to parse API response: ${raw.substring(0, 200)}`));
                }
            });
        });

        req.on('error', (err) => reject(new Error(`Databricks API request failed: ${err.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Databricks API request timed out'));
        });

        if (bodyStr) {
            req.write(bodyStr);
        }
        req.end();
    });
}
