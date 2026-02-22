/**
 * Cost Model - Heuristic cost scoring for PySpark operations
 */

import { AnalysisResult, ClusterInfo, Issue, Severity } from '../models/types';
import { COST_WEIGHTS, DBU_DEFAULTS } from '../models/constants';
import { PlanIssue } from './planParser';

export interface CostBreakdown {
    totalCost: number;
    joinCost: number;
    shuffleCost: number;
    issueCost: number;
    details: CostDetail[];
}

export interface CostDetail {
    source: string;
    cost: number;
    description: string;
}

/**
 * Calculate a heuristic cost score from plan issues and analysis issues.
 */
export function calculateCost(planIssues: PlanIssue[], analysisIssues: Issue[]): CostBreakdown {
    const details: CostDetail[] = [];
    let joinCost = 0;
    let shuffleCost = 0;
    let issueCost = 0;

    // Cost from plan operations
    for (const pi of planIssues) {
        details.push({
            source: pi.name,
            cost: pi.costPoints,
            description: pi.description,
        });

        if (pi.type === 'join') { joinCost += pi.costPoints; }
        else if (pi.type === 'shuffle') { shuffleCost += pi.costPoints; }
    }

    // Cost from analysis issues by severity
    for (const issue of analysisIssues) {
        const cost = severityCost(issue.severity);
        if (cost > 0) {
            details.push({
                source: issue.id,
                cost,
                description: issue.title,
            });
            issueCost += cost;
        }
    }

    return {
        totalCost: joinCost + shuffleCost + issueCost,
        joinCost,
        shuffleCost,
        issueCost,
        details,
    };
}

function severityCost(severity: Severity): number {
    switch (severity) {
        case Severity.CRITICAL: return 100;
        case Severity.WARNING: return 30;
        case Severity.INFO: return 5;
        case Severity.SUGGESTION: return 1;
    }
}

export interface DollarEstimate {
    formatted: string;    // e.g. "$4.50" or "50pts"
    dollars?: number;
    costPoints: number;
}

/**
 * Estimate dollar cost from cost points using cluster info.
 * Falls back to "Xpts" if no cluster info available.
 *
 * Formula: dollars = costPoints * secondsPerCostPoint * (totalCores / coresPerDBU) * (dbuRate / 3600)
 */
export function estimateDollarCost(
    costPoints: number,
    cluster?: ClusterInfo,
    dbuRatePerHour?: number,
): DollarEstimate {
    if (!cluster || !cluster.totalCores) {
        return { formatted: `${costPoints}pts`, costPoints };
    }

    const rate = dbuRatePerHour ?? DBU_DEFAULTS.defaultDBURatePerHour;
    const dollars = costPoints
        * DBU_DEFAULTS.secondsPerCostPoint
        * (cluster.totalCores / DBU_DEFAULTS.coresPerDBU)
        * (rate / 3600);

    return {
        formatted: `$${dollars.toFixed(2)}`,
        dollars,
        costPoints,
    };
}

/**
 * Estimate dollar cost for a serverless run from the total scanned data size.
 *
 * Formula: dollars = (totalBytes / throughput_per_sec / 3600) * ratePerHour
 *
 * throughput: conservative Delta scan speed (500 MB/s without Photon)
 * ratePerHour: user-configured serverless $/hr (DBU rate × expected DBUs/hr)
 */
export function estimateDollarCostFromTableStats(
    totalBytes: number,
    serverlessRatePerHour?: number,
): DollarEstimate {
    if (totalBytes === 0) {
        return { formatted: 'unknown', costPoints: 0 };
    }
    const rate = serverlessRatePerHour ?? DBU_DEFAULTS.defaultServerlessRatePerHour;
    const throughput = DBU_DEFAULTS.serverlessThroughputBytesPerSec;
    const estimatedHours = totalBytes / throughput / 3600;
    const dollars = estimatedHours * rate;
    return {
        formatted: dollars < 0.0001 ? '<$0.0001' : `~$${dollars.toFixed(4)}`,
        dollars,
        costPoints: 0,
    };
}

/**
 * Estimate dollar cost from actual measured execution duration.
 *
 * When AQE is enabled, queryExecution().executedPlan() triggers real query
 * execution and returns runtime statistics — so planDurationMs is the true
 * wall-clock time the query spent on the cluster.
 *
 * Formula: dollars = (durationMs / 3_600_000) * (totalCores / coresPerDBU) * dbuRate
 */
export function estimateDollarCostFromDuration(
    durationMs: number,
    cluster: ClusterInfo,
    dbuRatePerHour?: number,
): DollarEstimate {
    const rate = dbuRatePerHour ?? DBU_DEFAULTS.defaultDBURatePerHour;
    const dbus = (cluster.totalCores / DBU_DEFAULTS.coresPerDBU) * (durationMs / 3_600_000);
    const dollars = dbus * rate;
    return {
        formatted: dollars < 0.0001 ? '<$0.0001' : `$${dollars.toFixed(4)}`,
        dollars,
        costPoints: 0,
    };
}

/**
 * Get a human-readable cost label.
 */
export function costLabel(totalCost: number): string {
    if (totalCost === 0) { return 'Optimal'; }
    if (totalCost < 50) { return 'Low'; }
    if (totalCost < 200) { return 'Moderate'; }
    if (totalCost < 500) { return 'High'; }
    return 'Critical';
}
