/**
 * Databricks OAuth U2M (User-to-Machine) authentication using PKCE.
 *
 * Flow:
 *  1. Generate PKCE code_verifier + code_challenge
 *  2. Open browser to {host}/oidc/v1/authorize
 *  3. Spin up a local HTTP server to catch the redirect callback
 *  4. Exchange auth code for access_token + refresh_token
 *  5. Store refresh_token in VS Code SecretStorage
 *  6. Cache access_token in memory; auto-refresh on expiry
 *
 * Uses Node.js built-ins (http, crypto) — no new dependencies.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { logDebug, logError } from '../logger';
import { getSecrets } from '../extensionContext';

const CLIENT_ID = 'databricks-cli';
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Thrown when OAuth authentication fails so callers can surface targeted UX. */
export class OAuthU2mError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OAuthU2mError';
    }
}

interface TokenCache {
    accessToken: string;
    expiresAt: number; // epoch ms
}

// Per-host in-memory access token cache
const tokenCache = new Map<string, TokenCache>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the full browser-based OAuth PKCE flow for the given host.
 * Stores the refresh_token securely. Returns the access_token.
 */
export async function startOAuthFlow(host: string): Promise<string> {
    const normalizedHost = normalizeHost(host);
    const tokenEndpoint = `${normalizedHost}/oidc/v1/token`;

    const { codeVerifier, codeChallenge } = generatePkce();
    const state = crypto.randomBytes(16).toString('hex');

    const { port, waitForCode } = await startCallbackServer(state);
    const redirectUri = `http://localhost:${port}`;

    const authUrl = buildAuthUrl(normalizedHost, redirectUri, codeChallenge, state);
    logDebug(`oauthU2m: opening browser: ${authUrl}`);
    await vscode.env.openExternal(vscode.Uri.parse(authUrl));

    let code: string;
    try {
        code = await waitForCode;
    } catch (err) {
        throw new OAuthU2mError(err instanceof Error ? err.message : String(err));
    }

    const tokens = await exchangeCodeForTokens(tokenEndpoint, code, redirectUri, codeVerifier);

    // Store refresh token securely
    const secretKey = refreshTokenKey(normalizedHost);
    await Promise.resolve(getSecrets().store(secretKey, tokens.refreshToken));
    logDebug('oauthU2m: refresh token stored in SecretStorage');

    // Cache access token
    tokenCache.set(normalizedHost, {
        accessToken: tokens.accessToken,
        expiresAt: Date.now() + (tokens.expiresIn - 60) * 1000,
    });

    return tokens.accessToken;
}

/**
 * Get a valid OAuth access token for the given host.
 * Returns cached token if still valid; otherwise refreshes using stored refresh_token.
 * Throws OAuthU2mError if no refresh token is stored (user must re-run Configure Connection).
 */
export async function getOAuthToken(host: string): Promise<string> {
    const normalizedHost = normalizeHost(host);
    const now = Date.now();

    const cached = tokenCache.get(normalizedHost);
    if (cached && now < cached.expiresAt) {
        logDebug('oauthU2m: returning cached access token');
        return cached.accessToken;
    }

    logDebug('oauthU2m: access token expired or missing, refreshing');
    return refreshAccessToken(normalizedHost);
}

/** Clears the in-memory access token cache (e.g. after a 401). */
export function clearOAuthTokenCache(host: string): void {
    tokenCache.delete(normalizeHost(host));
}

/**
 * Returns true if a refresh token is stored for this host.
 * Used by the connection wizard to detect whether OAuth is already configured.
 */
export async function checkOAuthConfigured(host: string): Promise<boolean> {
    const key = refreshTokenKey(normalizeHost(host));
    const stored = await Promise.resolve(getSecrets().get(key)).catch(() => undefined);
    return !!stored;
}

/** Removes the stored refresh token for this host (e.g. on sign-out). */
export async function deleteOAuthRefreshToken(host: string): Promise<void> {
    await Promise.resolve(getSecrets().delete(refreshTokenKey(normalizeHost(host))));
    clearOAuthTokenCache(host);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function normalizeHost(host: string): string {
    let h = host.replace(/\/+$/, '');
    if (!h.startsWith('https://')) { h = 'https://' + h; }
    return h;
}

function refreshTokenKey(normalizedHost: string): string {
    // Strip protocol and replace non-alphanumeric characters for a safe key
    const sanitized = normalizedHost.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_');
    return `catalystops.oauth.refreshToken.${sanitized}`;
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    return { codeVerifier, codeChallenge };
}

function buildAuthUrl(host: string, redirectUri: string, codeChallenge: string, state: string): string {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'all-apis offline_access',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
    });
    return `${host}/oidc/v1/authorize?${params.toString()}`;
}

/**
 * Start a local HTTP server on a random port, wait for the OAuth callback.
 * Returns the port and a promise that resolves with the auth code (or rejects on timeout/error).
 */
function startCallbackServer(expectedState: string): Promise<{ port: number; waitForCode: Promise<string> }> {
    return new Promise((resolveSetup, rejectSetup) => {
        const server = http.createServer();

        const waitForCode = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                server.close();
                reject(new Error('OAuth login timed out (5 minutes). Please try again.'));
            }, OAUTH_TIMEOUT_MS);

            server.on('request', (req, res) => {
                if (!req.url) {
                    res.writeHead(400).end();
                    return;
                }

                clearTimeout(timeout);
                const params = new URL(req.url, 'http://localhost').searchParams;
                const error = params.get('error');
                const code = params.get('code');
                const state = params.get('state');

                const html = (title: string, body: string) =>
                    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><h2>${title}</h2><p>${body}</p></body></html>`;

                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html' }).end(
                        html('Authentication failed', `Error: ${error}. You can close this tab.`),
                    );
                    server.close();
                    reject(new Error(`OAuth error: ${error} — ${params.get('error_description') ?? ''}`));
                    return;
                }

                if (!code || state !== expectedState) {
                    res.writeHead(400, { 'Content-Type': 'text/html' }).end(
                        html('Invalid response', 'Unexpected response from Databricks. You can close this tab.'),
                    );
                    server.close();
                    reject(new Error('OAuth callback received invalid state or missing code'));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'text/html' }).end(
                    html('Connected!', 'You are now connected to Databricks. You can close this tab and return to VS Code.'),
                );
                server.close();
                resolve(code);
            });

            server.on('error', (err) => {
                clearTimeout(timeout);
                reject(new Error(`OAuth callback server error: ${err.message}`));
            });
        });

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                rejectSetup(new Error('Failed to start OAuth callback server'));
                return;
            }
            resolveSetup({ port: addr.port, waitForCode });
        });
    });
}

interface TokenResponse {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}

async function exchangeCodeForTokens(
    tokenEndpoint: string,
    code: string,
    redirectUri: string,
    codeVerifier: string,
): Promise<TokenResponse> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
    });

    return postToTokenEndpoint(tokenEndpoint, body);
}

async function refreshAccessToken(normalizedHost: string): Promise<string> {
    const secretKey = refreshTokenKey(normalizedHost);
    const refreshToken = await Promise.resolve(getSecrets().get(secretKey)).catch(() => undefined);

    if (!refreshToken) {
        throw new OAuthU2mError(
            'No OAuth refresh token found. Run "CatalystOps: Configure Databricks Connection" to log in again.',
        );
    }

    const tokenEndpoint = `${normalizedHost}/oidc/v1/token`;
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
    });

    let tokens: TokenResponse;
    try {
        tokens = await postToTokenEndpoint(tokenEndpoint, body);
    } catch (err) {
        logError(`oauthU2m: token refresh failed: ${err}`);
        // Delete stale refresh token so the user gets a clean re-auth prompt
        await Promise.resolve(getSecrets().delete(secretKey)).catch(() => undefined);
        throw new OAuthU2mError(
            'OAuth session expired. Run "CatalystOps: Configure Databricks Connection" to log in again.',
        );
    }

    // Store updated refresh token if the server rotated it
    if (tokens.refreshToken) {
        await Promise.resolve(getSecrets().store(secretKey, tokens.refreshToken));
    }

    tokenCache.set(normalizedHost, {
        accessToken: tokens.accessToken,
        expiresAt: Date.now() + (tokens.expiresIn - 60) * 1000,
    });

    logDebug('oauthU2m: access token refreshed');
    return tokens.accessToken;
}

function postToTokenEndpoint(endpoint: string, body: URLSearchParams): Promise<TokenResponse> {
    return new Promise((resolve, reject) => {
        const bodyStr = body.toString();
        const parsed = new URL(endpoint);

        const req = require('https').request(
            {
                hostname: parsed.hostname,
                port: 443,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(bodyStr),
                },
                timeout: 15000,
            },
            (res: http.IncomingMessage) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf-8');
                    let parsed: Record<string, unknown>;
                    try { parsed = JSON.parse(raw); } catch {
                        return reject(new Error(`Token endpoint returned non-JSON: ${raw.slice(0, 200)}`));
                    }
                    if (parsed.error) {
                        return reject(new Error(`Token endpoint error: ${parsed.error} — ${parsed.error_description ?? ''}`));
                    }
                    if (!parsed.access_token) {
                        return reject(new Error('Token endpoint did not return access_token'));
                    }
                    resolve({
                        accessToken: parsed.access_token as string,
                        refreshToken: (parsed.refresh_token as string) ?? '',
                        expiresIn: (parsed.expires_in as number) ?? 3600,
                    });
                });
            },
        );

        req.on('error', (err: Error) => reject(new Error(`Token request failed: ${err.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Token request timed out')); });
        req.write(bodyStr);
        req.end();
    });
}
