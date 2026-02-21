/**
 * Result Mapper - Maps AnalysisResult JSON from cluster to VS Code diagnostics
 */

import * as vscode from 'vscode';
import { AnalysisResult, CodeIssue, Severity, IssueCategory } from '../models/types';
import { PlanIssue } from './planParser';

/**
 * Map AnalysisResult[] from cluster to CodeIssue[] for diagnostics.
 * Attempts to map issue locations back to source lines.
 */
export function mapResultsToDiagnostics(
    results: AnalysisResult[],
    document: vscode.TextDocument,
): CodeIssue[] {
    const issues: CodeIssue[] = [];
    const text = document.getText();

    for (const result of results) {
        for (const issue of result.issues) {
            const { line, column } = resolveLocation(issue.location, text, result.dataframeName, issue.id);

            issues.push({
                ...issue,
                severity: issue.severity as Severity,
                category: issue.category as IssueCategory,
                line,
                column,
                endLine: line,
                endColumn: column + 20, // Approximate
            });
        }
    }

    return issues;
}

/**
 * Try to resolve an issue location string to a line/column in the document.
 */
function resolveLocation(
    location: string | undefined,
    text: string,
    dataframeName: string | undefined,
    issueId?: string,
): { line: number; column: number } {
    // Try to parse "Line N" format from code analyzer
    if (location) {
        const lineMatch = location.match(/Line\s+(\d+)/i);
        if (lineMatch) {
            return { line: parseInt(lineMatch[1], 10) - 1, column: 0 };
        }
    }

    // Try to find the DataFrame variable in the source
    if (dataframeName) {
        const lines = text.split('\n');

        // For join/broadcast issues, try to find .join() calls on this df first
        if (issueId && /JOIN|BROADCAST/i.test(issueId)) {
            for (let i = 0; i < lines.length; i++) {
                const joinPattern = new RegExp(`\\b${escapeRegex(dataframeName)}\\.join\\s*\\(`);
                if (joinPattern.test(lines[i])) {
                    return { line: i, column: lines[i].indexOf(dataframeName) };
                }
            }
            // Also check for any .join() call referencing this df as argument
            for (let i = 0; i < lines.length; i++) {
                if (/\.join\s*\(/.test(lines[i]) && lines[i].includes(dataframeName)) {
                    const col = lines[i].indexOf('.join');
                    return { line: i, column: col >= 0 ? col : 0 };
                }
            }
        }

        // For stats issues, try to find spark.table("...") references
        if (issueId && /STATS|STATISTIC/i.test(issueId)) {
            for (let i = 0; i < lines.length; i++) {
                if (/spark\.table\s*\(|spark\.read\.table\s*\(/.test(lines[i])) {
                    return { line: i, column: 0 };
                }
            }
        }

        for (let i = 0; i < lines.length; i++) {
            // Look for df assignment or usage
            const assignPattern = new RegExp(`\\b${escapeRegex(dataframeName)}\\s*=`);
            if (assignPattern.test(lines[i])) {
                return { line: i, column: lines[i].indexOf(dataframeName) };
            }
        }
        // Look for .join(), .groupBy(), etc. related to this df
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(dataframeName + '.')) {
                return { line: i, column: lines[i].indexOf(dataframeName) };
            }
        }
    }

    // Default to first line
    return { line: 0, column: 0 };
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert PlanIssue[] (from parsePlan) into CodeIssue[] so they appear as
 * VS Code diagnostics, Problems panel entries, and sidebar tree items.
 */
export function mapPlanIssuesToDiagnostics(
    planIssues: PlanIssue[],
    document: vscode.TextDocument,
    results: AnalysisResult[],
): CodeIssue[] {
    const lines = document.getText().split('\n');
    const dataframeName = results[0]?.dataframeName;

    return planIssues.map(pi => {
        const { line, column } = resolvePlanIssueLocation(pi, lines, dataframeName);
        return {
            id: pi.name,
            severity: planIssueSeverity(pi.costPoints),
            category: planIssueCategory(pi.type),
            title: planIssueTitle(pi.name),
            description: pi.description,
            location: `Line ${line + 1}`,
            fix: { description: '' },
            line,
            column,
            endLine: line,
            endColumn: column + 30,
        };
    });
}

function planIssueSeverity(costPoints: number): Severity {
    if (costPoints >= 80) { return Severity.CRITICAL; }
    if (costPoints >= 30) { return Severity.WARNING; }
    if (costPoints >= 10) { return Severity.INFO; }
    return Severity.SUGGESTION;
}

function planIssueCategory(type: PlanIssue['type']): IssueCategory {
    switch (type) {
        case 'join': return IssueCategory.JOIN;
        case 'shuffle': return IssueCategory.SHUFFLE;
        case 'cache': return IssueCategory.CACHING;
        case 'format': return IssueCategory.SERIALIZATION;
        case 'partition': return IssueCategory.PARTITIONING;
        case 'aggregation': return IssueCategory.CODE;
        case 'statistics': return IssueCategory.CONFIGURATION;
        case 'pushdown': return IssueCategory.RESOURCE;
    }
}

function planIssueTitle(name: string): string {
    const titles: Record<string, string> = {
        BroadcastHashJoin: 'Broadcast Hash Join',
        BroadcastJoinSinglePartition: 'Broadcast Join → Single Partition Bottleneck',
        SortMergeJoin: 'Sort-Merge Join',
        BroadcastableSmallSide: 'Small Side Not Broadcast in Sort-Merge Join',
        ShuffledHashJoin: 'Shuffled Hash Join',
        CartesianProduct: 'Cartesian Product',
        BroadcastNestedLoopJoin: 'Broadcast Nested Loop Join',
        Exchange: 'Shuffle Exchange',
        TooFewShufflePartitions: 'Too Few Shuffle Partitions',
        MissingStatistics: 'Missing Table Statistics',
        CacheRescan: 'Cached Relation Re-Scanned',
        CacheMemorySpillRisk: 'Cache Will Spill to Disk',
        LargeCache: 'Large Cached Relation',
        CsvRead: 'CSV Format — Use Parquet/Delta',
        FirstWithoutOrdering: 'first() Without Ordering Guarantee',
        RepeatedFileScan: 'Same Source Scanned Multiple Times',
        LargeDfPersisted: 'Large DataFrame Cached',
        CacheDiskSpill: 'Cache Spilling to Disk',
        CacheDeserialized: 'Cache Using Deserialized Java Objects',
        DefaultShufflePartitions: 'Default 200 Shuffle Partitions on Large Data',
    };
    return titles[name] ?? name;
}

/**
 * Map a PlanIssue to a source line using pattern matching on the issue type.
 */
function resolvePlanIssueLocation(
    issue: PlanIssue,
    lines: string[],
    dataframeName?: string,
): { line: number; column: number } {
    // For repeated reads, use the captured table/path name to find the exact read call
    if (issue.name === 'RepeatedFileScan' && issue.tableName) {
        const tableParts = issue.tableName.split('.');
        // Try progressively shorter name segments (catalog.schema.table → schema.table → table)
        for (let depth = 0; depth < tableParts.length; depth++) {
            const lookup = tableParts.slice(depth).join('.');
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i];
                if (/spark\.(table|read)/.test(l) &&
                    (l.includes(`"${lookup}"`) || l.includes(`'${lookup}'`))) {
                    return { line: i, column: l.indexOf('spark') };
                }
            }
        }
        // Fallback: any spark.table or spark.read call
        for (let i = 0; i < lines.length; i++) {
            if (/spark\.(table|read)\s*[\.(]/.test(lines[i])) {
                return { line: i, column: 0 };
            }
        }
    }

    const patterns: Record<string, RegExp[]> = {
        join: [/\.join\s*\(/, /\.crossJoin\s*\(/],
        shuffle: [/\.groupBy\s*\(/, /\.orderBy\s*\(/, /\.sort\s*\(/, /\.repartition\s*\(/],
        statistics: [/spark\.table\s*\(/, /spark\.read\.table\s*\(/],
        cache: [/\.cache\s*\(/, /\.persist\s*\(/, /\.checkpoint\s*\(/, /spark\.read\s*\./],
        format: [/\.csv\s*\(/, /read\.csv/, /format\s*\(\s*["']csv/i, /format\s*\(\s*["']text/i],
        partition: [/\.repartition\s*\(/, /\.coalesce\s*\(/],
        aggregation: [/\.agg\s*\(/, /\.first\s*\(/, /\.groupBy\s*\(/],
        pushdown: [/\.filter\s*\(/, /\.where\s*\(/],
    };

    const candidates = patterns[issue.type] ?? [];

    for (const re of candidates) {
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
                return { line: i, column: 0 };
            }
        }
    }

    // Fall back to where the DataFrame variable is used
    if (dataframeName) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(dataframeName + '.') || lines[i].includes(dataframeName + ' ')) {
                return { line: i, column: lines[i].indexOf(dataframeName) };
            }
        }
    }

    return { line: 0, column: 0 };
}
