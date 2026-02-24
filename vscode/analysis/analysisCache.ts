/**
 * Analysis Cache - Stores last analysis results and provides per-line cost lookups.
 * Fires events when cache updates so CodeLens can refresh.
 */

import * as vscode from 'vscode';
import { AnalysisResult } from '../models/types';
import { PlanIssue } from './planParser';

export interface LineCostEntry {
    costPoints: number;
    dollarEstimate?: string;
    joinType?: string;
    issues: PlanIssue[];
}

/** Module-level cache */
let cachedResults: AnalysisResult[] = [];
let cachedPlanIssues: PlanIssue[] = [];
let lineCostMap = new Map<string, Map<number, LineCostEntry>>();

const _onCacheUpdated = new vscode.EventEmitter<void>();

/** Event that fires when the analysis cache is updated */
export const onCacheUpdated: vscode.Event<void> = _onCacheUpdated.event;

/**
 * Update the cache with new analysis results and plan issues.
 * Maps plan issues to source lines using DataFrame variable name matching.
 */
export function updateCache(
    results: AnalysisResult[],
    planIssues: PlanIssue[],
    document: vscode.TextDocument,
): void {
    cachedResults = results;
    cachedPlanIssues = planIssues;

    const docKey = document.uri.toString();
    const lineMap = new Map<number, LineCostEntry>();
    const text = document.getText();
    const lines = text.split('\n');

    for (const issue of planIssues) {
        const line = findLineForPlanIssue(issue, lines, results);
        if (line < 0) { continue; }

        const existing = lineMap.get(line);
        if (existing) {
            existing.costPoints += issue.costPoints;
            existing.issues.push(issue);
            if (issue.type === 'join') { existing.joinType = issue.name; }
        } else {
            lineMap.set(line, {
                costPoints: issue.costPoints,
                joinType: issue.type === 'join' ? issue.name : undefined,
                issues: [issue],
            });
        }
    }

    lineCostMap.set(docKey, lineMap);
    _onCacheUpdated.fire();
}

/**
 * Get cost info for a specific line in a document.
 */
export function getLineCost(documentUri: string, line: number): LineCostEntry | undefined {
    return lineCostMap.get(documentUri)?.get(line);
}

/**
 * Get all cached line costs for a document.
 */
export function getAllLineCosts(documentUri: string): Map<number, LineCostEntry> | undefined {
    return lineCostMap.get(documentUri);
}

/** Get the last cached analysis results */
export function getCachedResults(): AnalysisResult[] {
    return cachedResults;
}

/** Get the last cached plan issues */
export function getCachedPlanIssues(): PlanIssue[] {
    return cachedPlanIssues;
}

/** Clear cache for a document */
export function clearCache(documentUri: string): void {
    lineCostMap.delete(documentUri);
}

/**
 * Try to find the source line for a plan issue by matching DataFrame names
 * to .join() calls in the source.
 */
function findLineForPlanIssue(
    issue: PlanIssue,
    lines: string[],
    results: AnalysisResult[],
): number {
    // For join issues, find .join() calls
    if (issue.type === 'join') {
        for (let i = 0; i < lines.length; i++) {
            if (/\.join\s*\(/.test(lines[i]) || /\.crossJoin\s*\(/.test(lines[i])) {
                return i;
            }
        }
    }

    // For shuffle issues, find groupBy/orderBy/repartition
    if (issue.type === 'shuffle') {
        for (let i = 0; i < lines.length; i++) {
            if (/\.(?:groupBy|orderBy|sort|repartition)\s*\(/.test(lines[i])) {
                return i;
            }
        }
    }

    return -1;
}
