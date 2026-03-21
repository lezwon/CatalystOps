/**
 * Databricks Jobs API wrapper — list jobs and fetch run metadata.
 */

import { apiRequest } from './client';

export interface JobSummary {
    jobId: number;
    name: string;
}

export interface RunState {
    life_cycle_state: 'PENDING' | 'RUNNING' | 'TERMINATING' | 'TERMINATED' | 'SKIPPED' | 'INTERNAL_ERROR';
    result_state?: 'SUCCESS' | 'FAILED' | 'TIMEDOUT' | 'CANCELED';
    state_message?: string;
}

export interface RunSummary {
    runId: number;
    jobId: number;
    state: RunState;
    startTimeMs: number;
    endTimeMs?: number;
    durationMs?: number;
    clusterId?: string;
    numberInJob?: number;
}

export async function listJobs(host: string, token: string): Promise<JobSummary[]> {
    const resp = await apiRequest<{ jobs?: any[] }>({
        host, token, method: 'GET',
        path: '/api/2.1/jobs/list?limit=25&expand_tasks=false',
    });
    return (resp.data.jobs ?? []).map(j => ({
        jobId: j.job_id as number,
        name: (j.settings?.name ?? `Job ${j.job_id}`) as string,
    }));
}

export async function getLastRun(host: string, token: string, jobId: number): Promise<RunSummary | undefined> {
    const resp = await apiRequest<{ runs?: any[] }>({
        host, token, method: 'GET',
        path: `/api/2.1/jobs/runs/list?job_id=${jobId}&limit=1&active_only=false`,
    });
    const run = resp.data.runs?.[0];
    return run ? parseRunSummary(run) : undefined;
}

export async function getRunDetails(host: string, token: string, runId: number): Promise<RunSummary> {
    const resp = await apiRequest<any>({
        host, token, method: 'GET',
        path: `/api/2.1/jobs/runs/get?run_id=${runId}`,
    });
    return parseRunSummary(resp.data);
}

/**
 * Look up the cluster's DBFS event log destination and return the full
 * path to the event log directory for this cluster.
 *
 * Falls back to the well-known default path `dbfs:/cluster-logs/<clusterId>/eventlog`
 * when the cluster API returns no log conf (e.g. terminated job clusters, workspace-level
 * log delivery configured outside the cluster spec).
 */
export async function getClusterEventLogPath(host: string, token: string, clusterId: string): Promise<string | undefined> {
    try {
        const resp = await apiRequest<any>({
            host, token, method: 'GET',
            path: `/api/2.0/clusters/get?cluster_id=${clusterId}`,
        });
        const dest = resp.data?.cluster_log_conf?.dbfs?.destination as string | undefined;
        if (dest) {
            return `${dest.replace(/\/$/, '')}/${clusterId}/eventlog`;
        }
    } catch { /* cluster may be terminated — fall through to default */ }

    // Fall back to the Databricks default delivery path
    return `dbfs:/cluster-logs/${clusterId}/eventlog`;
}

export interface JobRunSource {
    type: 'notebook' | 'python_file' | 'unknown';
    path: string;
    content?: string;
}

/**
 * Fetch the source code that was run in a job.
 * Supports notebook tasks and Python script tasks (workspace or DBFS).
 */
export async function getJobRunSource(host: string, token: string, runId: number): Promise<JobRunSource | undefined> {
    const resp = await apiRequest<any>({
        host, token, method: 'GET',
        path: `/api/2.1/jobs/runs/get?run_id=${runId}`,
    });
    const run = resp.data;
    // Multi-task jobs: take the first task; single-task jobs put it at root level
    const task = run.tasks?.[0] ?? run;

    if (task.notebook_task?.notebook_path) {
        const nbPath = task.notebook_task.notebook_path as string;
        const exportResp = await apiRequest<{ content?: string }>({
            host, token, method: 'GET',
            path: `/api/2.0/workspace/export?path=${encodeURIComponent(nbPath)}&format=SOURCE`,
            timeoutMs: 15000,
        });
        const content = exportResp.data.content
            ? Buffer.from(exportResp.data.content, 'base64').toString('utf-8')
            : undefined;
        return { type: 'notebook', path: nbPath, content };
    }

    if (task.spark_python_task?.python_file) {
        const filePath = task.spark_python_task.python_file as string;
        if (filePath.startsWith('dbfs:') || filePath.startsWith('/')) {
            const dbfsResp = await apiRequest<{ data?: string }>({
                host, token, method: 'GET',
                path: `/api/2.0/dbfs/read?path=${encodeURIComponent(filePath)}&offset=0&length=${5 * 1024 * 1024}`,
                timeoutMs: 15000,
            });
            const content = dbfsResp.data.data
                ? Buffer.from(dbfsResp.data.data, 'base64').toString('utf-8')
                : undefined;
            return { type: 'python_file', path: filePath, content };
        } else {
            const exportResp = await apiRequest<{ content?: string }>({
                host, token, method: 'GET',
                path: `/api/2.0/workspace/export?path=${encodeURIComponent(filePath)}&format=SOURCE`,
                timeoutMs: 15000,
            });
            const content = exportResp.data.content
                ? Buffer.from(exportResp.data.content, 'base64').toString('utf-8')
                : undefined;
            return { type: 'python_file', path: filePath, content };
        }
    }

    return { type: 'unknown', path: '' };
}

function parseRunSummary(run: any): RunSummary {
    const state: RunState = run.state ?? { life_cycle_state: 'PENDING' };
    const startTimeMs = (run.start_time as number) ?? 0;
    const endTimeMs = (run.end_time as number) || undefined;

    // cluster_instance is set at the root for single-task jobs; for multi-task
    // jobs each task carries its own cluster_instance — fall back to the first task.
    const clusterId: string | undefined =
        run.cluster_instance?.cluster_id
        ?? run.tasks?.[0]?.cluster_instance?.cluster_id
        ?? run.cluster_spec?.existing_cluster_id
        ?? run.tasks?.[0]?.existing_cluster_id
        ?? undefined;

    return {
        runId: run.run_id as number,
        jobId: run.job_id as number,
        state,
        startTimeMs,
        endTimeMs,
        durationMs: endTimeMs ? endTimeMs - startTimeMs : undefined,
        clusterId,
        numberInJob: run.number_in_job as number | undefined,
    };
}
