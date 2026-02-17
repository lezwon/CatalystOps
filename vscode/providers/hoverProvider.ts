/**
 * Hover provider - markdown cards with issue details and fix suggestions
 */

import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from '../models/constants';

/**
 * Create a hover provider that shows detailed fix information for CatalystOps diagnostics.
 */
export function createHoverProvider(): vscode.HoverProvider {
    return {
        provideHover(
            document: vscode.TextDocument,
            position: vscode.Position,
        ): vscode.Hover | undefined {
            // Find CatalystOps diagnostics at this position
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            const catalystDiags = diagnostics.filter(d =>
                d.source === DIAGNOSTIC_SOURCE && d.range.contains(position),
            );

            if (catalystDiags.length === 0) { return undefined; }

            const parts: vscode.MarkdownString[] = [];

            for (const diag of catalystDiags) {
                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                md.supportThemeIcons = true;

                const severityIcon = getSeverityIcon(diag.severity);
                md.appendMarkdown(`### ${severityIcon} ${diag.code}\n\n`);
                md.appendMarkdown(`${diag.message}\n\n`);

                // Add fix info from the pattern lookup
                const fixInfo = getFixInfo(diag.code as string);
                if (fixInfo) {
                    md.appendMarkdown(`**Fix:** ${fixInfo.description}\n\n`);
                    if (fixInfo.code) {
                        md.appendCodeblock(fixInfo.code, 'python');
                    }
                    if (fixInfo.configChanges) {
                        md.appendMarkdown('\n**Configuration:**\n');
                        for (const [key, value] of Object.entries(fixInfo.configChanges)) {
                            md.appendCodeblock(`spark.conf.set("${key}", "${value}")`, 'python');
                        }
                    }
                }

                parts.push(md);
            }

            return new vscode.Hover(parts);
        },
    };
}

function getSeverityIcon(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error: return '$(error)';
        case vscode.DiagnosticSeverity.Warning: return '$(warning)';
        case vscode.DiagnosticSeverity.Information: return '$(info)';
        default: return '$(lightbulb)';
    }
}

/** Simple fix info lookup by pattern ID */
function getFixInfo(patternId: string): { description: string; code?: string; configChanges?: Record<string, string> } | undefined {
    // This provides hover info for cluster-sourced issues
    const fixes: Record<string, { description: string; code?: string; configChanges?: Record<string, string> }> = {
        'JOIN_BROADCAST_001': {
            description: 'Use broadcast join for the smaller table',
            code: 'from pyspark.sql.functions import broadcast\ndf = large_df.join(broadcast(small_df), "key")',
            configChanges: { 'spark.sql.autoBroadcastJoinThreshold': '104857600' },
        },
        'JOIN_CARTESIAN_001': {
            description: 'Add explicit join conditions to avoid cartesian product',
            code: 'df1.join(df2, df1["key"] == df2["key"])',
        },
        'SHUFFLE_EXCESSIVE_001': {
            description: 'Reduce the number of shuffle operations by reordering transformations',
        },
        'SHUFFLE_PARTITION_001': {
            description: 'Tune shuffle partitions based on data size',
            configChanges: { 'spark.sql.shuffle.partitions': '200' },
        },
        'RESOURCE_AQE_001': {
            description: 'Enable Adaptive Query Execution for automatic optimization',
            configChanges: { 'spark.sql.adaptive.enabled': 'true' },
        },
    };

    return fixes[patternId];
}
