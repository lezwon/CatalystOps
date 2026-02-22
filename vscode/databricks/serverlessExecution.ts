/**
 * Databricks Serverless Compute execution via Jobs API 2.0.
 * No cluster ID required — compute is provisioned on-demand.
 */

import { apiRequest } from './client';
import { POLLING } from '../models/constants';

export interface ServerlessAvailability {
    available: boolean;
    reason?: string;
}

/**
 * Check whether serverless compute is available for this workspace.
 * Always returns available — the workspace-conf key (enableServerlessCompute)
 * is unreliable on newer workspaces where serverless is enabled at the account
 * level without setting that key. Any actual unavailability is surfaced when
 * the job is submitted in submitServerlessRun().
 */
export async function checkServerlessAvailability(
    _host: string,
    _token: string,
): Promise<ServerlessAvailability> {
    return { available: true };
}

/**
 * Upload a Python script to DBFS and return its path.
 * Path: dbfs:/tmp/catalystops/run_<timestamp>.py
 */
export async function uploadScriptToDbfs(
    host: string,
    token: string,
    content: string,
): Promise<string> {
    const path = `dbfs:/tmp/catalystops/run_${Date.now()}.py`;
    const contents = Buffer.from(content, 'utf-8').toString('base64');

    const resp = await apiRequest<{ error_code?: string; message?: string }>({
        host, token, method: 'POST',
        path: '/api/2.0/dbfs/put',
        body: { path, contents, overwrite: true },
    });

    if (resp.statusCode !== 200) {
        throw new Error(`Failed to upload script to DBFS: ${JSON.stringify(resp.data)}`);
    }

    return path;
}

/**
 * Delete a file from DBFS. Best-effort — errors are swallowed.
 */
export async function deleteDbfsFile(
    host: string,
    token: string,
    path: string,
): Promise<void> {
    try {
        await apiRequest({
            host, token, method: 'POST',
            path: '/api/2.0/dbfs/delete',
            body: { path, recursive: false },
        });
    } catch {
        // Best effort
    }
}

/**
 * Submit a serverless job run for the given DBFS script path.
 * Returns the run_id string.
 */
export async function submitServerlessRun(
    host: string,
    token: string,
    dbfsPath: string,
): Promise<string> {
    const resp = await apiRequest<{ run_id?: number; error_code?: string; message?: string }>({
        host, token, method: 'POST',
        path: '/api/2.0/jobs/runs/submit',
        body: {
            run_name: 'catalystops-dryrun',
            environments: [
                {
                    environment_key: 'default',
                    spec: { client: '1' },
                },
            ],
            tasks: [
                {
                    task_key: 'analysis',
                    environment_key: 'default',
                    spark_python_task: { python_file: dbfsPath },
                },
            ],
        },
    });

    if (resp.statusCode !== 200 || resp.data.run_id === undefined) {
        const reason = resp.data?.message ?? JSON.stringify(resp.data);
        throw new Error(`Failed to submit serverless run: ${reason}`);
    }

    return String(resp.data.run_id);
}

type JobRunOutcome = 'SUCCESS' | 'FAILED' | 'TIMEOUT';

interface JobRunGetResponse {
    state?: {
        life_cycle_state?: string;
        result_state?: string;
    };
}

/**
 * Poll a job run until it reaches a terminal state or times out.
 * Uses the same exponential backoff as pollCommand.
 */
export async function pollJobRun(
    host: string,
    token: string,
    runId: string,
    onProgress: (elapsedMs: number) => void,
    timeoutMs: number = POLLING.timeoutMs,
): Promise<JobRunOutcome> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let delay: number = POLLING.initialDelayMs;

    const NON_TERMINAL = new Set(['PENDING', 'RUNNING', 'TERMINATING']);

    while (Date.now() < deadline) {
        const resp = await apiRequest<JobRunGetResponse>({
            host, token, method: 'GET',
            path: `/api/2.0/jobs/runs/get?run_id=${runId}`,
        });

        const lifeCycleState = resp.data?.state?.life_cycle_state ?? '';
        const resultState = resp.data?.state?.result_state ?? '';

        if (!NON_TERMINAL.has(lifeCycleState)) {
            // Terminal state reached
            if (lifeCycleState === 'TERMINATED') {
                return resultState === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
            }
            // INTERNAL_ERROR or SKIPPED
            return 'FAILED';
        }

        onProgress(Date.now() - start);
        await sleep(delay);
        delay = Math.min(delay * POLLING.backoffMultiplier, POLLING.maxDelayMs);
    }

    // Timeout — attempt to cancel best-effort
    await cancelJobRun(host, token, runId);
    return 'TIMEOUT';
}

interface JobRunOutputResponse {
    logs?: string;
}

/**
 * Retrieve the stdout logs from a completed job run.
 * The sentinel markers used by extractResult() are present in logs.
 */
export async function getJobRunOutput(
    host: string,
    token: string,
    runId: string,
): Promise<string> {
    const resp = await apiRequest<JobRunOutputResponse>({
        host, token, method: 'GET',
        path: `/api/2.0/jobs/runs/get-output?run_id=${runId}`,
    });

    if (resp.statusCode !== 200) {
        throw new Error(`Failed to get job run output: ${JSON.stringify(resp.data)}`);
    }

    return resp.data?.logs ?? '';
}

/**
 * Cancel a running job. Best-effort — errors are swallowed.
 */
export async function cancelJobRun(
    host: string,
    token: string,
    runId: string,
): Promise<void> {
    try {
        await apiRequest({
            host, token, method: 'POST',
            path: '/api/2.0/jobs/runs/cancel',
            body: { run_id: Number(runId) },
        });
    } catch {
        // Best effort
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
