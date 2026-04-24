/**
 * MCP State — in-memory snapshot updated after each local analysis run.
 * The MCP server reads this to serve get_active_file_issues and the issues resource.
 */

import { CodeIssue } from '../models/types';
import { PlanIssue } from '../analysis/planParser';
import { AnalysisResult } from '../models/types';
import { BundleConfig } from '../databricks/bundleParser';

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

export interface McpJobRunSnapshot {
    jobName: string;
    runId: number;
    planEntries: Array<{ description: string; physicalPlan: string }>;
    planIssues: PlanIssue[];
    updatedAt: Date;
}

let _issueSnapshot: McpIssueSnapshot | null = null;
let _planSnapshot: McpPlanSnapshot | null = null;
let _jobRunSnapshot: McpJobRunSnapshot | null = null;
let _bundleConfig: BundleConfig | null = null;

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

export function updateMcpJobRunSnapshot(snapshot: McpJobRunSnapshot): void {
    _jobRunSnapshot = snapshot;
}

export function getMcpJobRunSnapshot(): McpJobRunSnapshot | null {
    return _jobRunSnapshot;
}

export function updateMcpBundleConfig(config: BundleConfig | undefined): void {
    _bundleConfig = config ?? null;
}

export function getMcpBundleConfig(): BundleConfig | null {
    return _bundleConfig;
}
