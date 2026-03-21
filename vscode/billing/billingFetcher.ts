/**
 * Fetches billing rows from system.billing.usage via the
 * Databricks SQL Statement Execution API (api/2.0/sql/statements).
 */

import * as vscode from 'vscode';
import { BillingRow } from './billingTypes';
import { DatabricksConnectionConfig } from '../config/settings';
import { apiRequest } from '../databricks/client';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SqlWarehouse {
    id: string;
    name: string;
    state: string;
    warehouse_type?: 'CLASSIC' | 'PRO' | 'SERVERLESS';
    enable_serverless_compute?: boolean;
}

interface SqlColumn {
    name: string;
    position: number;
}

interface SqlStatementStatus {
    state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'CLOSED';
    error?: { message: string; error_code: string };
}

interface SqlStatementResponse {
    statement_id: string;
    status: SqlStatementStatus;
    manifest?: {
        schema: { columns: SqlColumn[] };
        total_chunk_count?: number;
    };
    result?: {
        data_array?: (string | null)[][];
    };
}

interface SqlChunkResponse {
    data_array?: (string | null)[][];
}

// ---------------------------------------------------------------------------
// Warehouse discovery
// ---------------------------------------------------------------------------

/**
 * Resolve a SQL warehouse ID to use for the billing query.
 * Preference order:
 *   1. catalystops.billing.warehouseId setting (if set)
 *   2. First RUNNING warehouse from the API
 *   3. First warehouse of any state
 */
async function resolveWarehouseId(config: DatabricksConnectionConfig): Promise<string> {
    const configured = vscode.workspace
        .getConfiguration('catalystops')
        .get<string>('billing.warehouseId', '');
    if (configured) { return configured; }

    const resp = await apiRequest<{ warehouses?: SqlWarehouse[] }>({
        host: config.host,
        token: config.token,
        method: 'GET',
        path: '/api/2.0/sql/warehouses',
    });

    const warehouses = resp.data?.warehouses ?? [];
    if (warehouses.length === 0) {
        throw new Error(
            'No SQL warehouses found. Create a SQL warehouse in your Databricks workspace, ' +
            'or set catalystops.billing.warehouseId in VS Code settings.',
        );
    }

    const isServerless = (w: SqlWarehouse) =>
        w.warehouse_type === 'SERVERLESS' || w.enable_serverless_compute === true;

    return (
        warehouses.find(w => isServerless(w) && w.state === 'RUNNING') ??
        warehouses.find(w => isServerless(w)) ??
        warehouses.find(w => w.state === 'RUNNING') ??
        warehouses[0]
    ).id;
}

// ---------------------------------------------------------------------------
// SQL Statement Execution
// ---------------------------------------------------------------------------

const BILLING_SQL = (startDate: string, endDate: string) => `
SELECT
    CAST(u.usage_date AS STRING)                            AS date,
    u.billing_origin_product                                AS workloadType,
    COALESCE(u.identity_metadata.run_as,
             u.identity_metadata.created_by,
             u.identity_metadata.owned_by)                  AS runAs,
    u.usage_metadata.job_id                                 AS jobId,
    FIRST(u.usage_metadata.job_name)                        AS jobName,
    u.sku_name                                              AS skuName,
    SUM(u.usage_quantity)                                   AS dbus,
    SUM(u.usage_quantity * COALESCE(lp.pricing.default, 0)) AS dollars
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices lp
    ON  u.sku_name          = lp.sku_name
    AND u.usage_unit        = lp.usage_unit
    AND u.usage_start_time >= lp.price_start_time
    AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)
WHERE u.usage_date >= '${startDate}'
  AND u.usage_date <= '${endDate}'
  AND u.record_type = 'ORIGINAL'
GROUP BY date, workloadType, runAs, jobId, skuName
ORDER BY dollars DESC
`;

async function submitStatement(
    config: DatabricksConnectionConfig,
    warehouseId: string,
    statement: string,
): Promise<SqlStatementResponse> {
    const resp = await apiRequest<SqlStatementResponse>({
        host: config.host,
        token: config.token,
        method: 'POST',
        path: '/api/2.0/sql/statements',
        body: { statement, warehouse_id: warehouseId, wait_timeout: '0s' },
    });

    if (resp.statusCode !== 200) {
        throw new Error(`Failed to submit SQL statement: ${JSON.stringify(resp.data)}`);
    }
    return resp.data;
}

async function pollStatement(
    config: DatabricksConnectionConfig,
    statementId: string,
    timeoutMs = 300_000,
): Promise<SqlStatementResponse> {
    const deadline = Date.now() + timeoutMs;
    let delay = 2_000;
    const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'CLOSED']);

    while (Date.now() < deadline) {
        const resp = await apiRequest<SqlStatementResponse>({
            host: config.host,
            token: config.token,
            method: 'GET',
            path: `/api/2.0/sql/statements/${statementId}`,
        });

        if (resp.statusCode !== 200) {
            throw new Error(`SQL statement poll failed: ${JSON.stringify(resp.data)}`);
        }

        const state = resp.data?.status?.state;
        if (state && TERMINAL.has(state)) { return resp.data; }

        await sleep(delay);
        delay = Math.min(delay * 1.5, 10_000);
    }

    await apiRequest({
        host: config.host,
        token: config.token,
        method: 'POST',
        path: `/api/2.0/sql/statements/${statementId}/cancel`,
    }).catch(() => {});

    throw new Error('Billing SQL query timed out after 5 minutes.');
}

async function collectAllRows(
    config: DatabricksConnectionConfig,
    statementId: string,
    firstResponse: SqlStatementResponse,
): Promise<(string | null)[][]> {
    const rows: (string | null)[][] = [...(firstResponse.result?.data_array ?? [])];
    const totalChunks = firstResponse.manifest?.total_chunk_count ?? 1;

    for (let chunkIndex = 1; chunkIndex < totalChunks; chunkIndex++) {
        const resp = await apiRequest<SqlChunkResponse>({
            host: config.host,
            token: config.token,
            method: 'GET',
            path: `/api/2.0/sql/statements/${statementId}/result/chunks/${chunkIndex}`,
        });
        rows.push(...(resp.data?.data_array ?? []));
    }

    return rows;
}

function parseRows(data: (string | null)[][], columns: SqlColumn[]): BillingRow[] {
    const idx: Record<string, number> = {};
    for (const col of columns) { idx[col.name] = col.position; }

    return data.map(row => ({
        date:         String(row[idx['date']]         ?? ''),
        workloadType: String(row[idx['workloadType']] ?? ''),
        runAs:        String(row[idx['runAs']]        ?? ''),
        jobId:        row[idx['jobId']]   != null ? String(row[idx['jobId']])   : null,
        jobName:      row[idx['jobName']] != null ? String(row[idx['jobName']]) : undefined,
        skuName:      String(row[idx['skuName']]      ?? ''),
        dbus:         Number(row[idx['dbus']]         ?? 0),
        dollars:      Number(row[idx['dollars']]      ?? 0),
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch billing rows for the given explicit date range.
 * Auto-discovers a SQL warehouse unless catalystops.billing.warehouseId is set.
 */
export async function fetchBillingRows(
    config: DatabricksConnectionConfig,
    startDate: string,
    endDate: string,
    _context: vscode.ExtensionContext,
): Promise<BillingRow[]> {
    const warehouseId = await resolveWarehouseId(config);

    let result = await submitStatement(config, warehouseId, BILLING_SQL(startDate, endDate));

    const state = result.status?.state;
    if (state === 'FAILED' || state === 'CANCELED' || state === 'CLOSED') {
        const errMsg = result.status?.error?.message ?? 'SQL query failed';
        if (errMsg.includes('system.billing') || errMsg.includes('TABLE_OR_VIEW_NOT_FOUND')) {
            throw new Error('Cannot access system.billing.usage. Ensure Unity Catalog System Tables are enabled.');
        }
        throw new Error(`Billing query failed: ${errMsg}`);
    }

    if (state !== 'SUCCEEDED') {
        result = await pollStatement(config, result.statement_id);
    }

    if (result.status?.state !== 'SUCCEEDED') {
        const errMsg = result.status?.error?.message ?? 'SQL query failed';
        throw new Error(`Billing query failed: ${errMsg}`);
    }

    const columns = result.manifest?.schema?.columns ?? [];
    const allRows = await collectAllRows(config, result.statement_id, result);
    return parseRows(allRows, columns);
}

const COST_SQL = (where: string) => `
SELECT
    SUM(u.usage_quantity * COALESCE(lp.pricing.default, 0)) AS dollars,
    SUM(u.usage_quantity)                                    AS dbus
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices lp
    ON  u.sku_name          = lp.sku_name
    AND u.usage_unit        = lp.usage_unit
    AND u.usage_start_time >= lp.price_start_time
    AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)
WHERE u.record_type = 'ORIGINAL'
  AND ${where}
`;

async function runCostQuery(
    config: DatabricksConnectionConfig,
    warehouseId: string,
    where: string,
): Promise<{ dollars: number; dbus: number } | null> {
    let result = await submitStatement(config, warehouseId, COST_SQL(where));
    const state = result.status?.state;
    if (state === 'FAILED' || state === 'CANCELED' || state === 'CLOSED') { return null; }
    if (state !== 'SUCCEEDED') {
        result = await pollStatement(config, result.statement_id, 60_000);
    }
    if (result.status?.state !== 'SUCCEEDED') { return null; }

    const row = result.result?.data_array?.[0];
    if (!row) { return null; }

    const dollars = Number(row[0] ?? 0);
    const dbus    = Number(row[1] ?? 0);
    return dollars > 0 || dbus > 0 ? { dollars, dbus } : null;
}

function toIsoDateFromMs(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Fetch the actual DBU cost for a specific job run from system.billing.usage.
 *
 * Strategy:
 *  1. Exact match on usage_metadata.job_run_id (most precise).
 *  2. If no data, fall back to job_id + a 3-day window around the run's start
 *     date (handles workspaces where job_run_id is not populated, and data
 *     latency of up to ~2 hours).
 *
 * Returns null when no data is found in either pass.
 * Throws on unexpected SQL errors.
 */
export async function fetchJobRunCost(
    config: DatabricksConnectionConfig,
    runId: number,
    jobId: number,
    runStartMs?: number,
): Promise<{ dollars: number; dbus: number; approximate?: boolean } | null> {
    const warehouseId = await resolveWarehouseId(config);

    // Pass 1: exact run match via job_run_id
    const exactWhere = `u.usage_metadata.job_id = '${jobId}'
  AND TRY_CAST(u.usage_metadata.job_run_id AS BIGINT) = ${runId}`;
    const exact = await runCostQuery(config, warehouseId, exactWhere);
    if (exact) { return exact; }

    // Pass 2: job_id + date window fallback (handles missing job_run_id or billing delay)
    if (runStartMs) {
        const runDate = toIsoDateFromMs(runStartMs);
        // Window: 1 day before through 2 days after (billing can lag ~2 hours, crossing midnight)
        const windowStart = toIsoDateFromMs(runStartMs - 86_400_000);
        const windowEnd   = toIsoDateFromMs(runStartMs + 2 * 86_400_000);
        const dateWhere = `u.usage_metadata.job_id = '${jobId}'
  AND u.usage_date >= '${windowStart}'
  AND u.usage_date <= '${windowEnd}'`;
        const approx = await runCostQuery(config, warehouseId, dateWhere);
        if (approx) { return { ...approx, approximate: true }; }
    }

    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
