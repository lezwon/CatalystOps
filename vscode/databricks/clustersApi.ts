/**
 * Databricks Clusters API wrapper — list and manage interactive clusters.
 */

import { apiRequest } from './client';

export type ClusterState =
    | 'PENDING'
    | 'RUNNING'
    | 'RESTARTING'
    | 'RESIZING'
    | 'TERMINATING'
    | 'TERMINATED'
    | 'ERROR'
    | 'UNKNOWN';

export interface ClusterInfo {
    clusterId: string;
    clusterName: string;
    state: ClusterState;
    sparkVersion: string;
    numWorkers?: number;
    driverNodeTypeId?: string;
    singleUserName?: string;
    creatorUserName?: string;
    clusterSource?: string;
}

export async function listClusters(host: string, token: string): Promise<ClusterInfo[]> {
    const resp = await apiRequest<{ clusters?: any[] }>({
        host, token, method: 'GET',
        path: '/api/2.0/clusters/list',
    });
    const clusters = resp.data.clusters ?? [];
    // Only show interactive (all-purpose) clusters, not ephemeral job clusters
    return clusters
        .filter(c => {
            const src = (c.cluster_source as string | undefined) ?? '';
            return src !== 'JOB' && src !== 'MODELS';
        })
        .map(c => ({
            clusterId: c.cluster_id as string,
            clusterName: (c.cluster_name ?? c.cluster_id) as string,
            state: (c.state ?? 'UNKNOWN') as ClusterState,
            sparkVersion: (c.spark_version ?? '') as string,
            numWorkers: c.num_workers as number | undefined,
            driverNodeTypeId: c.driver_node_type_id as string | undefined,
            singleUserName: c.single_user_name as string | undefined,
            creatorUserName: c.creator_user_name as string | undefined,
            clusterSource: c.cluster_source as string | undefined,
        }));
}

/** Returns the email/userName of the currently authenticated user. */
export async function getCurrentUserEmail(host: string, token: string): Promise<string> {
    const resp = await apiRequest<{ userName?: string; emails?: { value: string }[] }>({
        host, token, method: 'GET',
        path: '/api/2.0/preview/scim/v2/Me',
    });
    return resp.data.userName ?? resp.data.emails?.[0]?.value ?? '';
}

/**
 * Ensure the Databricks Secrets scope used by `databricks ssh connect` exists.
 * Scope name format: `{email}-{clusterId}-ssh-tunnel-keys`
 *
 * On Standard-tier workspaces, scope creation requires `initial_manage_principal: "users"`.
 * If the scope already exists, the API returns an error we silently ignore.
 */
export async function ensureSshSecretScope(host: string, token: string, email: string, clusterId: string): Promise<void> {
    const scope = `${email}-${clusterId}-ssh-tunnel-keys`;
    try {
        await apiRequest<unknown>({
            host, token, method: 'POST',
            path: '/api/2.0/secrets/scopes/create',
            body: { scope, initial_manage_principal: 'users' },
        });
    } catch {
        // Scope already exists or insufficient permissions — both are acceptable.
    }
}

export async function startCluster(host: string, token: string, clusterId: string): Promise<void> {
    await apiRequest<unknown>({
        host, token, method: 'POST',
        path: '/api/2.0/clusters/start',
        body: { cluster_id: clusterId },
    });
}

export async function stopCluster(host: string, token: string, clusterId: string): Promise<void> {
    await apiRequest<unknown>({
        host, token, method: 'POST',
        path: '/api/2.0/clusters/delete',
        body: { cluster_id: clusterId },
    });
}

export async function getClusterState(host: string, token: string, clusterId: string): Promise<ClusterState> {
    const resp = await apiRequest<{ state?: string }>({
        host, token, method: 'GET',
        path: `/api/2.0/clusters/get?cluster_id=${clusterId}`,
    });
    return (resp.data.state ?? 'UNKNOWN') as ClusterState;
}

/** Returns the raw cluster spec (the `spec` field) plus current state. */
export async function getClusterSpec(host: string, token: string, clusterId: string): Promise<{ spec: Record<string, unknown>; sparkVersion: string; state: ClusterState }> {
    const resp = await apiRequest<{ spec?: Record<string, unknown>; spark_version?: string; state?: string }>(
        { host, token, method: 'GET', path: `/api/2.0/clusters/get?cluster_id=${clusterId}` },
    );
    return {
        spec: resp.data.spec ?? {},
        sparkVersion: (resp.data.spark_version ?? '') as string,
        state: (resp.data.state ?? 'UNKNOWN') as ClusterState,
    };
}

/** Edit a cluster — pass the full spec with any overrides merged in. */
export async function editCluster(host: string, token: string, clusterId: string, spec: Record<string, unknown>): Promise<void> {
    await apiRequest<unknown>({
        host, token, method: 'POST',
        path: '/api/2.0/clusters/edit',
        body: { ...spec, cluster_id: clusterId },
    });
}

/** Restart a running cluster. */
export async function restartCluster(host: string, token: string, clusterId: string): Promise<void> {
    await apiRequest<unknown>({
        host, token, method: 'POST',
        path: '/api/2.0/clusters/restart',
        body: { cluster_id: clusterId },
    });
}
