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
 * Upload a Python script as a workspace notebook and return its notebook path.
 * Stored at: /Shared/catalystops/run_<timestamp>  (no .py — workspace import strips it)
 *
 * Uses the Workspace Import API with format=SOURCE so the script is stored as a
 * Python source notebook. Intended to be run with notebook_task, which has a full
 * Spark context on Databricks serverless compute.
 */
export async function uploadScriptToWorkspace(
    host: string,
    token: string,
    content: string,
): Promise<string> {
    const notebookPath = `/Shared/catalystops/run_${Date.now()}`;

    // Ensure parent folder exists (mkdirs is idempotent)
    const mkdirResp = await apiRequest<{ error_code?: string; message?: string }>({
        host, token, method: 'POST',
        path: '/api/2.0/workspace/mkdirs',
        body: { path: '/Shared/catalystops' },
    });
    if (mkdirResp.statusCode !== 200) {
        throw new Error(`Failed to create workspace folder: ${JSON.stringify(mkdirResp.data)}`);
    }

    const encodedContent = Buffer.from(content, 'utf-8').toString('base64');
    const resp = await apiRequest<{ error_code?: string; message?: string }>({
        host, token, method: 'POST',
        path: '/api/2.0/workspace/import',
        body: {
            path: notebookPath,
            format: 'SOURCE',
            language: 'PYTHON',
            content: encodedContent,
            overwrite: true,
        },
    });

    if (resp.statusCode !== 200) {
        throw new Error(`Failed to upload script to Workspace: ${JSON.stringify(resp.data)}`);
    }

    return notebookPath;
}

/**
 * Delete a workspace notebook. Best-effort — errors are swallowed.
 */
export async function deleteWorkspaceFile(
    host: string,
    token: string,
    notebookPath: string,
): Promise<void> {
    try {
        await apiRequest({
            host, token, method: 'POST',
            path: '/api/2.0/workspace/delete',
            body: { path: notebookPath, recursive: false },
        });
    } catch {
        // Best effort
    }
}

/**
 * Submit a serverless job run for the given script path.
 * Accepts a workspace path (/Workspace/...) or a DBFS path (dbfs:/...).
 * Returns the run_id string.
 */
export async function submitServerlessRun(
    host: string,
    token: string,
    scriptPath: string,
): Promise<string> {
    const resp = await apiRequest<{ run_id?: number; error_code?: string; message?: string }>({
        host, token, method: 'POST',
        path: '/api/2.0/jobs/runs/submit',
        body: {
            run_name: 'catalystops-dryrun',
            // notebook_task runs on serverless Spark compute (Free Edition compatible).
            // No cluster or environments block needed — serverless is used automatically.
            tasks: [
                {
                    task_key: 'analysis',
                    notebook_task: {
                        notebook_path: scriptPath,
                        source: 'WORKSPACE',
                    },
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
    run_page_url?: string;
}

export interface PollJobRunResult {
    outcome: JobRunOutcome;
    /** Direct link to the run in the Databricks UI, e.g. https://host/#job/.../run/... */
    runPageUrl?: string;
}

/**
 * Poll a job run until it reaches a terminal state or times out.
 * Uses the same exponential backoff as pollCommand.
 * Returns the outcome and the Databricks UI run URL.
 */
export async function pollJobRun(
    host: string,
    token: string,
    runId: string,
    onProgress: (elapsedMs: number) => void,
    timeoutMs: number = POLLING.timeoutMs,
): Promise<PollJobRunResult> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let delay: number = POLLING.initialDelayMs;
    let runPageUrl: string | undefined;

    const NON_TERMINAL = new Set(['PENDING', 'RUNNING', 'TERMINATING']);

    while (Date.now() < deadline) {
        const resp = await apiRequest<JobRunGetResponse>({
            host, token, method: 'GET',
            path: `/api/2.0/jobs/runs/get?run_id=${runId}`,
        });

        // Capture the run page URL from the first response that has it
        if (!runPageUrl && resp.data?.run_page_url) {
            runPageUrl = resp.data.run_page_url;
        }

        const lifeCycleState = resp.data?.state?.life_cycle_state ?? '';
        const resultState = resp.data?.state?.result_state ?? '';

        if (!NON_TERMINAL.has(lifeCycleState)) {
            // Terminal state reached
            if (lifeCycleState === 'TERMINATED') {
                return { outcome: resultState === 'SUCCESS' ? 'SUCCESS' : 'FAILED', runPageUrl };
            }
            // INTERNAL_ERROR or SKIPPED
            return { outcome: 'FAILED', runPageUrl };
        }

        onProgress(Date.now() - start);
        await sleep(delay);
        delay = Math.min(delay * POLLING.backoffMultiplier, POLLING.maxDelayMs);
    }

    // Timeout — attempt to cancel best-effort
    await cancelJobRun(host, token, runId);
    return { outcome: 'TIMEOUT', runPageUrl };
}

interface JobRunOutputResponse {
    logs?: string;
    notebook_output?: { result?: string };
}

/**
 * Retrieve output from a completed job run.
 * notebook_task puts output in notebook_output.result (via dbutils.notebook.exit()).
 * spark_python_task / cluster runs put stdout in logs.
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

    // notebook_task: result is set via dbutils.notebook.exit()
    // spark_python_task / cluster: result is in driver stdout logs
    return resp.data?.notebook_output?.result ?? resp.data?.logs ?? '';
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
