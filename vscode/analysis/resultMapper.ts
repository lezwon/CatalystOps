/**
 * Result Mapper - Maps AnalysisResult JSON from cluster to VS Code diagnostics
 */

import * as vscode from 'vscode';
import { AnalysisResult, CodeIssue, Severity, IssueCategory } from '../models/types';

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
