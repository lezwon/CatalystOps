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

/**
 * Fetch the Databricks UI URL for a run immediately after submission.
 * Makes a single jobs/runs/get request and returns run_page_url.
 * Best-effort — returns undefined if the call fails.
 */
export async function getJobRunPageUrl(
    host: string,
    token: string,
    runId: string,
): Promise<string | undefined> {
    try {
        const resp = await apiRequest<{ run_page_url?: string }>({
            host, token, method: 'GET',
            path: `/api/2.0/jobs/runs/get?run_id=${runId}`,
        });
        return resp.data?.run_page_url;
    } catch {
        return undefined;
    }
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

export interface BillingResult {
    totalDBUs: number;
    usageUnit: string;
    skuName: string;
    /** Seconds waited for billing data to appear in system.billing.usage */
    waitedSecs?: number;
}

/**
 * Submit a background serverless job that queries system.billing.usage
 * for the completed run and returns actual DBU consumption.
 *
 * Billing data typically becomes available 1–5 minutes after run completion.
 * The generated notebook polls internally every 20 seconds for up to 5 minutes.
 *
 * Returns null if System Tables are not enabled, the table is inaccessible,
 * or billing data never appears within the timeout.
 */
export async function queryActualRunCost(
    host: string,
    token: string,
    runId: string,
): Promise<BillingResult | null> {
    const runIdInt = parseInt(runId, 10);
    if (isNaN(runIdInt)) { return null; }

    // The billing notebook polls system.billing.usage until data appears.
    // It tries both 'job_run_id' and 'run_id' field names — the field name
    // varies across Unity Catalog / workspace versions.
    const script = `# CatalystOps billing query — auto-generated
import json
import time as _time

_run_id = ${runIdInt}
_start = _time.time()
_max_wait = 300  # 5 minutes
_result = None

while _time.time() - _start < _max_wait:
    for _field in ("job_run_id", "run_id"):
        try:
            _rows = spark.sql(f"""
                SELECT ROUND(SUM(usage_quantity), 6) AS total_dbus,
                       first(usage_unit)              AS usage_unit,
                       first(sku_name)                AS sku_name
                FROM system.billing.usage
                WHERE usage_metadata.{_field} = {_run_id}
            """).collect()
            if _rows and _rows[0]["total_dbus"] and float(_rows[0]["total_dbus"]) > 0:
                _result = {
                    "totalDBUs":  float(_rows[0]["total_dbus"]),
                    "usageUnit":  str(_rows[0]["usage_unit"] or ""),
                    "skuName":    str(_rows[0]["sku_name"]   or ""),
                    "waitedSecs": round(_time.time() - _start),
                }
                break
        except Exception:
            pass
    if _result:
        break
    _time.sleep(20)

dbutils.notebook.exit(json.dumps(_result or {"totalDBUs": 0, "error": "no billing data"}))
`;

    let billingPath: string | undefined;
    try {
        billingPath = await uploadScriptToWorkspace(host, token, script);
        const billingRunId = await submitServerlessRun(host, token, billingPath);
        // 8-minute timeout: the notebook itself waits up to 5 min + startup overhead
        const { outcome } = await pollJobRun(host, token, billingRunId, () => {}, 480_000);
        if (outcome !== 'SUCCESS') { return null; }
        const output = await getJobRunOutput(host, token, billingRunId);
        const parsed = JSON.parse(output.trim()) as BillingResult & { error?: string };
        if (parsed.error || !parsed.totalDBUs || parsed.totalDBUs <= 0) { return null; }
        return { totalDBUs: parsed.totalDBUs, usageUnit: parsed.usageUnit, skuName: parsed.skuName, waitedSecs: parsed.waitedSecs };
    } catch {
        return null;
    } finally {
        if (billingPath) {
            deleteWorkspaceFile(host, token, billingPath).catch(() => {});
        }
    }
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
