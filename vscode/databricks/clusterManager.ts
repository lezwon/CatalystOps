/**
 * Cluster manager - check cluster state, prompt to start if needed
 */

import * as vscode from 'vscode';
import { apiRequest } from './client';
import { ClusterState } from '../models/types';

/**
 * Check if the cluster is running. If not, prompt user to start it.
 * Returns true if cluster is running or was started successfully.
 */
export async function ensureClusterRunning(
    host: string,
    token: string,
    clusterId: string,
): Promise<boolean> {
    const state = await getClusterState(host, token, clusterId);

    if (state.state === 'RUNNING') {
        return true;
    }

    if (state.state === 'TERMINATED') {
        const choice = await vscode.window.showWarningMessage(
            `Cluster is terminated. Start it for dry-run analysis?`,
            'Start Cluster',
            'Cancel',
        );

        if (choice === 'Start Cluster') {
            await startCluster(host, token, clusterId);
            vscode.window.showInformationMessage('Cluster starting... This may take a few minutes. Please retry analysis when ready.');
            return false;
        }
        return false;
    }

    if (state.state === 'PENDING' || state.state === 'RESTARTING' || state.state === 'RESIZING') {
        vscode.window.showInformationMessage(`Cluster is ${state.state.toLowerCase()}. Please retry analysis when the cluster is running.`);
        return false;
    }

    vscode.window.showErrorMessage(`Cluster is in ${state.state} state: ${state.stateMessage || 'Unknown error'}`);
    return false;
}

async function getClusterState(host: string, token: string, clusterId: string): Promise<ClusterState> {
    const resp = await apiRequest<{ state: string; state_message?: string }>({
        host, token, method: 'GET',
        path: `/api/2.0/clusters/get?cluster_id=${clusterId}`,
    });

    if (resp.statusCode !== 200) {
        const body = resp.data as Record<string, unknown>;
        const msg = body?.message || body?.error || JSON.stringify(body);
        throw new Error(`Failed to get cluster state (HTTP ${resp.statusCode}): ${msg}`);
    }

    return {
        clusterId,
        state: (resp.data.state as ClusterState['state']) || 'UNKNOWN',
        stateMessage: resp.data.state_message,
    };
}

async function startCluster(host: string, token: string, clusterId: string): Promise<void> {
    const resp = await apiRequest({
        host, token, method: 'POST',
        path: '/api/2.0/clusters/start',
        body: { cluster_id: clusterId },
    });

    if (resp.statusCode !== 200) {
        const body = resp.data as Record<string, unknown>;
        const msg = body?.message || body?.error || JSON.stringify(body);
        throw new Error(`Failed to start cluster (HTTP ${resp.statusCode}): ${msg}`);
    }
}
