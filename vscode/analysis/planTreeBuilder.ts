/**
 * Plan Tree Builder - Parses physical plan text into a navigable PlanNode tree.
 * Each node is annotated with matching PlanIssue and source line from dfLineMap.
 */

import { AnalysisResult } from '../models/types';
import { PlanIssue } from './planParser';

export interface PlanNode {
    id: string;
    operatorName: string;
    rawLine: string;
    depth: number;
    children: PlanNode[];
    issue?: PlanIssue;
    severity: 'critical' | 'warning' | 'info' | 'none';
    sourceLine?: number;
    dataframeName?: string;
}

const CRITICAL_OPS = [
    'SortMergeJoin', 'CartesianProduct', 'BroadcastNestedLoop', 'BroadcastJoinSinglePartition',
];
const WARNING_OPS = ['Exchange', 'SortAggregate'];
const INFO_OPS = ['BroadcastHashJoin'];

export function getSeverity(operatorName: string): 'critical' | 'warning' | 'info' | 'none' {
    if (CRITICAL_OPS.some(op => operatorName.includes(op))) { return 'critical'; }
    if (WARNING_OPS.some(op => operatorName.includes(op))) { return 'warning'; }
    if (INFO_OPS.some(op => operatorName.includes(op))) { return 'info'; }
    return 'none';
}

function findMatchingIssue(operatorName: string, planIssues: PlanIssue[]): PlanIssue | undefined {
    return planIssues.find(issue =>
        issue.name === operatorName ||
        operatorName.includes(issue.name) ||
        issue.name.includes(operatorName),
    );
}

/**
 * Parse a single plan line into depth and content.
 * Returns null for empty lines or plan headers (== ... ==).
 *
 * Depth algorithm:
 *   - Lines with no +- or :- marker → root (depth 0)
 *   - +- / :- found at column pos → depth = floor(pos / 3) + 1
 *   Each prefix group is exactly 3 chars (":  " or "   "), so depth * 3 = pos of marker.
 */
function parseLine(line: string): { depth: number; content: string } | null {
    const trimmed = line.trim();
    if (!trimmed || /^==\s/.test(trimmed)) { return null; }

    let pos = line.indexOf('+- ');
    if (pos < 0) { pos = line.indexOf(':- '); }

    if (pos >= 0) {
        const depth = Math.floor(pos / 3) + 1;
        const rawContent = line.slice(pos + 3).trim();
        // Strip codegen prefix: *(N)
        const content = rawContent.replace(/^\*\(\d+\)\s+/, '');
        return { depth, content: content || rawContent };
    }

    // Root node: no branch marker
    const content = trimmed.replace(/^\*\(\d+\)\s+/, '');
    return { depth: 0, content: content || trimmed };
}

let nodeCounter = 0;

function buildTree(
    physicalPlan: string,
    planIssues: PlanIssue[],
    dataframeName: string | undefined,
    sourceLine: number | undefined,
): PlanNode[] {
    const roots: PlanNode[] = [];
    const stack: (PlanNode | undefined)[] = [];
    let inInitialPlan = false;

    for (const line of physicalPlan.split('\n')) {
        if (/==\s*Initial Plan\s*==/i.test(line)) { inInitialPlan = true; }
        if (inInitialPlan) { continue; }

        const parsed = parseLine(line);
        if (!parsed) { continue; }

        const { depth, content } = parsed;
        const operatorName = content.split(/[\s[(,]/)[0] || content;
        const issue = findMatchingIssue(operatorName, planIssues);

        const node: PlanNode = {
            id: `node-${nodeCounter++}`,
            operatorName,
            rawLine: content,
            depth,
            children: [],
            issue,
            severity: getSeverity(operatorName),
            dataframeName,
            // Only root nodes (depth=0) carry the DataFrame source line
            sourceLine: depth === 0 ? sourceLine : undefined,
        };

        if (depth === 0) {
            roots.push(node);
            stack.length = 0;
            stack[0] = node;
        } else {
            const parent = stack[depth - 1];
            if (parent) {
                parent.children.push(node);
            }
            stack[depth] = node;
            stack.length = depth + 1;
        }
    }

    return roots;
}

/**
 * Build PlanNode trees from all analysis results.
 *
 * @param results   - Cached analysis results (each has executionPlan.physicalPlan)
 * @param planIssues - Plan issues for annotation
 * @param dfLineMap  - Maps dataframeName → 0-based source line in Python file
 */
export function buildPlanTrees(
    results: AnalysisResult[],
    planIssues: PlanIssue[],
    dfLineMap: Map<string, number>,
): PlanNode[] {
    nodeCounter = 0;
    const allRoots: PlanNode[] = [];

    for (const result of results) {
        if (!result.executionPlan?.physicalPlan) { continue; }
        const sourceLine = result.dataframeName
            ? dfLineMap.get(result.dataframeName)
            : undefined;
        const roots = buildTree(
            result.executionPlan.physicalPlan,
            planIssues,
            result.dataframeName,
            sourceLine,
        );
        allRoots.push(...roots);
    }

    return allRoots;
}
