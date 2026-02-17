/**
 * Cost Model - Heuristic cost scoring for PySpark operations
 */

import { AnalysisResult, Issue, Severity } from '../models/types';
import { COST_WEIGHTS } from '../models/constants';
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
