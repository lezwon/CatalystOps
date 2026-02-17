/**
 * Plan Parser - Parses explain("formatted") output for join types, shuffles, etc.
 */

import { AnalysisResult } from '../models/types';

export interface PlanIssue {
    type: 'join' | 'shuffle' | 'statistics' | 'pushdown';
    name: string;
    description: string;
    costPoints: number;
    planLine?: string;
}

/**
 * Parse Spark explain() output for optimization issues.
 */
export function parsePlan(planText: string): PlanIssue[] {
    const issues: PlanIssue[] = [];
    const lines = planText.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();

        // Detect join types
        if (/BroadcastHashJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'BroadcastHashJoin',
                description: 'Broadcast hash join detected (efficient for small tables)',
                costPoints: 1,
                planLine: trimmed,
            });
        } else if (/SortMergeJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'SortMergeJoin',
                description: 'Sort-merge join detected. Consider broadcasting the smaller table if it fits in memory',
                costPoints: 50,
                planLine: trimmed,
            });
        } else if (/ShuffledHashJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'ShuffledHashJoin',
                description: 'Shuffled hash join detected. Consider broadcasting the smaller table',
                costPoints: 30,
                planLine: trimmed,
            });
        } else if (/CartesianProduct/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'CartesianProduct',
                description: 'Cartesian product detected! This creates an O(n*m) result and is extremely expensive',
                costPoints: 1000,
                planLine: trimmed,
            });
        } else if (/BroadcastNestedLoopJoin/i.test(trimmed)) {
            issues.push({
                type: 'join',
                name: 'BroadcastNestedLoopJoin',
                description: 'Broadcast nested loop join detected. This is expensive for large datasets',
                costPoints: 80,
                planLine: trimmed,
            });
        }

        // Detect shuffle (Exchange) operations
        if (/Exchange\b/i.test(trimmed) && !/BroadcastExchange/i.test(trimmed)) {
            issues.push({
                type: 'shuffle',
                name: 'Exchange',
                description: 'Shuffle exchange detected. Data is being redistributed across partitions',
                costPoints: 20,
                planLine: trimmed,
            });
        }

        // Detect missing statistics
        if (/Statistics\(sizeInBytes=.*=-1\)/i.test(trimmed) ||
            /unknown/i.test(trimmed) && /statistic/i.test(trimmed)) {
            issues.push({
                type: 'statistics',
                name: 'MissingStatistics',
                description: 'Table statistics are missing. Run ANALYZE TABLE to help the optimizer make better join decisions',
                costPoints: 15,
                planLine: trimmed,
            });
        }
    }

    return issues;
}

/**
 * Calculate total cost score from plan issues.
 */
export function calculatePlanCost(issues: PlanIssue[]): number {
    return issues.reduce((total, issue) => total + issue.costPoints, 0);
}

/**
 * Parse plan data from cluster analysis results (AnalysisResult[]).
 */
export function parsePlanFromResults(results: AnalysisResult[]): PlanIssue[] {
    const allIssues: PlanIssue[] = [];

    for (const result of results) {
        if (result.executionPlan?.physicalPlan) {
            allIssues.push(...parsePlan(result.executionPlan.physicalPlan));
        }
    }

    return allIssues;
}
