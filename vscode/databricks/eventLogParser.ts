/**
 * Spark event log fetcher and parser.
 * Reads physical plans from SparkListenerSQLExecutionStart events stored in DBFS.
 */

import { apiRequest } from './client';
import { logDebug } from '../logger';

/** A single SQL execution entry extracted from a Spark event log. */
export interface SparkPlanEntry {
    executionId: number;
    description: string;
    physicalPlan: string;
}

const MAX_BYTES_TO_SCAN = 10 * 1024 * 1024; // 10 MB — sufficient for most jobs
const CHUNK_SIZE        =  256 * 1024;       // 256 KB — small reads, faster response
const CHUNK_TIMEOUT_MS  = 15_000;            // per DBFS read call
const TOTAL_TIMEOUT_MS  = 45_000;            // hard wall-clock limit for the whole scan

/**
 * Fetch and parse a Spark event log from DBFS.
 * Returns physical plan strings from SparkListenerSQLExecutionStart events.
 *
 * Normalises the file path to the dbfs: scheme (the DBFS list API returns bare
 * /path strings which can cause the read API to hang on some runtimes).
 * Enforces a hard 45-second total timeout and returns whatever plans were
 * collected so far if the limit is reached.
 */
export async function fetchPlansFromEventLog(
    host: string,
    token: string,
    logPath: string,
): Promise<SparkPlanEntry[]> {
    logDebug(`eventLog: resolving log file from base path: ${logPath}`);
    const rawPath = await resolveLogFile(host, token, logPath);
    logDebug(`eventLog: resolveLogFile returned: ${rawPath ?? '(undefined)'}`);
    if (!rawPath) { return []; }

    // DBFS list API returns bare '/path' strings; the read API can hang on some
    // Databricks runtimes unless the path uses the 'dbfs:' scheme.
    const filePath = rawPath.startsWith('/') ? `dbfs:${rawPath}` : rawPath;
    logDebug(`eventLog: normalized file path: ${filePath}`);

    const plans: SparkPlanEntry[] = [];
    let offset = 0;
    let remainder = '';

    // Hard timeout — resolves with whatever plans we have so far.
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        logDebug(`eventLog: TOTAL_TIMEOUT_MS (${TOTAL_TIMEOUT_MS}ms) reached at offset ${offset} — returning ${plans.length} plans collected so far`);
        timedOut = true;
    }, TOTAL_TIMEOUT_MS);

    try {
        while (!timedOut && offset < MAX_BYTES_TO_SCAN) {
            const length = Math.min(CHUNK_SIZE, MAX_BYTES_TO_SCAN - offset);
            logDebug(`eventLog: requesting chunk offset=${offset} length=${length}`);

            let resp: Awaited<ReturnType<typeof apiRequest<{ bytes_read?: number; data?: string }>>>;
            try {
                resp = await apiRequest<{ bytes_read?: number; data?: string }>({
                    host, token, method: 'GET',
                    path: `/api/2.0/dbfs/read?path=${encodeURIComponent(filePath)}&offset=${offset}&length=${length}`,
                    timeoutMs: CHUNK_TIMEOUT_MS,
                });
            } catch (err) {
                logDebug(`eventLog: apiRequest threw at offset=${offset}: ${err instanceof Error ? err.message : String(err)}`);
                break;
            }

            logDebug(`eventLog: chunk response status=${resp.statusCode} bytes_read=${resp.data.bytes_read ?? '?'} data_length=${resp.data.data?.length ?? 0}`);

            if (resp.statusCode !== 200 || !resp.data.data) {
                logDebug(`eventLog: stopping — non-200 or empty data`);
                break;
            }

            logDebug(`eventLog: decoding base64 chunk (${resp.data.data.length} chars)`);
            const chunk = Buffer.from(resp.data.data, 'base64').toString('utf-8');
            logDebug(`eventLog: decoded to ${chunk.length} chars, splitting lines`);
            const text = remainder + chunk;
            const lines = text.split('\n');
            remainder = lines.pop() ?? '';
            logDebug(`eventLog: ${lines.length} lines to scan, remainder=${remainder.length} chars`);

            let found = 0;
            for (const line of lines) {
                if (!line.includes('SparkListenerSQLExecutionStart')) { continue; }
                try {
                    const evt = JSON.parse(line);
                    if (
                        evt.Event === 'org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart' &&
                        typeof evt.physicalPlanDescription === 'string' &&
                        evt.physicalPlanDescription.length > 0
                    ) {
                        plans.push({
                            executionId: (evt.executionId as number) ?? 0,
                            description: (evt.description as string) ?? '',
                            physicalPlan: evt.physicalPlanDescription as string,
                        });
                        found++;
                    }
                } catch { /* skip malformed JSON lines */ }
            }
            logDebug(`eventLog: found ${found} plan(s) in chunk, total so far: ${plans.length}`);

            const bytesRead = resp.data.bytes_read ?? CHUNK_SIZE;
            offset += bytesRead;
            logDebug(`eventLog: advanced offset to ${offset} (bytesRead=${bytesRead})`);
            if (bytesRead < length) {
                logDebug(`eventLog: EOF reached (bytesRead ${bytesRead} < requested ${length})`);
                break;
            }
        }
    } finally {
        clearTimeout(timeoutHandle);
    }

    logDebug(`eventLog: scan complete — ${plans.length} plan(s) from ${offset} bytes`);
    return plans;
}

/**
 * Resolve a log path to an actual readable DBFS file.
 *
 * Databricks event log layout (up to 4 levels deep):
 *   {dest}/{clusterId}/eventlog/          ← logPath passed in
 *     {appId}/                            ← one dir per Spark app / job run
 *       {attemptId}/                      ← attempt directory (present on some runtimes)
 *         eventlog                        ← actual NDJSON event log file
 *
 * Strategy: use dbfs/list to distinguish files from directories — list returns
 * non-200 for plain files, so we never probe directory paths with dbfs/read
 * (which can hang on slow clusters).
 */
async function resolveLogFile(
    host: string,
    token: string,
    logPath: string,
    depth = 0,
): Promise<string | undefined> {
    const MAX_DEPTH = 4;
    if (depth > MAX_DEPTH) {
        logDebug(`eventLog: resolveLogFile MAX_DEPTH exceeded at ${logPath}`);
        return undefined;
    }

    logDebug(`eventLog: listing [depth=${depth}] ${logPath}`);
    const listResp = await apiRequest<{ files?: { path: string; is_dir: boolean; file_size?: number }[] }>({
        host, token, method: 'GET',
        path: `/api/2.0/dbfs/list?path=${encodeURIComponent(logPath)}`,
        timeoutMs: 15000,
    });
    logDebug(`eventLog: list status=${listResp.statusCode} entries=${listResp.data.files?.length ?? 0}`);

    if (listResp.statusCode !== 200) {
        logDebug(`eventLog: treating as file (list returned ${listResp.statusCode}): ${logPath}`);
        return logPath;
    }

    const entries = listResp.data.files ?? [];

    const files = entries.filter(f => !f.is_dir).sort((a, b) => b.path.localeCompare(a.path));
    if (files.length > 0) {
        logDebug(`eventLog: found file: ${files[0].path} (size=${files[0].file_size ?? '?'})`);
        return files[0].path;
    }

    const dirs = entries.filter(f => f.is_dir).sort((a, b) => b.path.localeCompare(a.path));
    logDebug(`eventLog: ${dirs.length} subdirectory(ies), descending into most recent: ${dirs[0]?.path ?? '(none)'}`);
    for (const dir of dirs) {
        const result = await resolveLogFile(host, token, dir.path, depth + 1);
        if (result) { return result; }
    }

    return undefined;
}
