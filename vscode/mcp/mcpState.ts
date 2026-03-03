/**
 * MCP State — in-memory snapshot updated after each local analysis run.
 * The MCP server reads this to serve get_active_file_issues and the issues resource.
 */

import { CodeIssue } from '../models/types';
import { PlanIssue } from '../analysis/planParser';
import { AnalysisResult } from '../models/types';

export interface McpIssueSnapshot {
    filePath: string;
    issues: CodeIssue[];
    updatedAt: Date;
}

export interface McpPlanSnapshot {
    analysisResults: AnalysisResult[];
    planIssues: PlanIssue[];
    updatedAt: Date;
}

let _issueSnapshot: McpIssueSnapshot | null = null;
let _planSnapshot: McpPlanSnapshot | null = null;

export function updateMcpSnapshot(snapshot: McpIssueSnapshot): void {
    _issueSnapshot = snapshot;
}

export function getMcpSnapshot(): McpIssueSnapshot | null {
    return _issueSnapshot;
}

export function updateMcpPlanSnapshot(snapshot: McpPlanSnapshot): void {
    _planSnapshot = snapshot;
}

export function getMcpPlanSnapshot(): McpPlanSnapshot | null {
    return _planSnapshot;
}
