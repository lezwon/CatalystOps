/**
 * Databricks Command Execution API 1.2
 * Execute Python code on an interactive cluster and poll for results.
 */

import { apiRequest } from './client';
import { CommandResult, CommandStatus } from '../models/types';
import { POLLING } from '../models/constants';

interface ExecutionContext {
    id: string;
}

/** Cached execution contexts by clusterId */
const contextCache = new Map<string, string>();

/**
 * Get or create an execution context for the given cluster.
 */
export async function getOrCreateContext(
    host: string,
    token: string,
    clusterId: string,
): Promise<string> {
    const cached = contextCache.get(clusterId);
    if (cached) {
        // Verify context is still valid
        try {
            const resp = await apiRequest<{ status: string }>({
                host, token, method: 'GET',
                path: `/api/1.2/contexts/status?clusterId=${clusterId}&contextId=${cached}`,
            });
            if (resp.statusCode === 200 && resp.data.status === 'Running') {
                return cached;
            }
        } catch {
            // Context invalid, create new one
        }
        contextCache.delete(clusterId);
    }

    const resp = await apiRequest<ExecutionContext>({
        host, token, method: 'POST',
        path: '/api/1.2/contexts/create',
        body: { clusterId, language: 'python' },
    });

    if (resp.statusCode !== 200 || !resp.data.id) {
        throw new Error(`Failed to create execution context: ${JSON.stringify(resp.data)}`);
    }

    // Wait for context to be running
    const contextId = resp.data.id;
    await waitForContext(host, token, clusterId, contextId);

    contextCache.set(clusterId, contextId);
    return contextId;
}

async function waitForContext(
    host: string,
    token: string,
    clusterId: string,
    contextId: string,
): Promise<void> {
    const deadline = Date.now() + POLLING.timeoutMs;
    let delay: number = POLLING.initialDelayMs;

    while (Date.now() < deadline) {
        const resp = await apiRequest<{ status: string }>({
            host, token, method: 'GET',
            path: `/api/1.2/contexts/status?clusterId=${clusterId}&contextId=${contextId}`,
        });

        if (resp.data.status === 'Running') { return; }
        if (resp.data.status === 'Error') {
            throw new Error('Execution context entered error state');
        }

        await sleep(delay);
        delay = Math.min(delay * POLLING.backoffMultiplier, POLLING.maxDelayMs);
    }

    throw new Error('Timed out waiting for execution context');
}

/**
 * Execute Python code on a Databricks cluster and wait for the result.
 */
export async function executeCommand(
    host: string,
    token: string,
    clusterId: string,
    code: string,
): Promise<CommandResult> {
    const contextId = await getOrCreateContext(host, token, clusterId);

    const execResp = await apiRequest<{ id: string }>({
        host, token, method: 'POST',
        path: '/api/1.2/commands/execute',
        body: { clusterId, contextId, language: 'python', command: code },
    });

    if (execResp.statusCode !== 200 || !execResp.data.id) {
        throw new Error(`Failed to execute command: ${JSON.stringify(execResp.data)}`);
    }

    const commandId = execResp.data.id;
    return pollCommand(host, token, clusterId, contextId, commandId);
}

async function pollCommand(
    host: string,
    token: string,
    clusterId: string,
    contextId: string,
    commandId: string,
): Promise<CommandResult> {
    const deadline = Date.now() + POLLING.timeoutMs;
    let delay: number = POLLING.initialDelayMs;

    while (Date.now() < deadline) {
        const resp = await apiRequest<CommandResult>({
            host, token, method: 'GET',
            path: `/api/1.2/commands/status?clusterId=${clusterId}&contextId=${contextId}&commandId=${commandId}`,
        });

        const status = resp.data.status;
        if (status === 'Finished' || status === 'Error' || status === 'Cancelled') {
            return resp.data;
        }

        await sleep(delay);
        delay = Math.min(delay * POLLING.backoffMultiplier, POLLING.maxDelayMs);
    }

    // Timeout: attempt to cancel
    try {
        await apiRequest({
            host, token, method: 'POST',
            path: '/api/1.2/commands/cancel',
            body: { clusterId, contextId, commandId },
        });
    } catch {
        // Best effort cancel
    }

    throw new Error('Command execution timed out after 60 seconds');
}

/**
 * Destroy a cached execution context.
 */
export async function destroyContext(
    host: string,
    token: string,
    clusterId: string,
): Promise<void> {
    const contextId = contextCache.get(clusterId);
    if (!contextId) { return; }

    try {
        await apiRequest({
            host, token, method: 'POST',
            path: '/api/1.2/contexts/destroy',
            body: { clusterId, contextId },
        });
    } catch {
        // Best effort
    }
    contextCache.delete(clusterId);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
