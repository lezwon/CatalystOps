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
