/**
 * Code Action provider - Quick-fix actions from Issue.fix
 */

import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from '../models/constants';

/**
 * Create a code action provider that offers quick fixes for CatalystOps diagnostics.
 */
export function createCodeActionProvider(): vscode.CodeActionProvider {
    return {
        provideCodeActions(
            document: vscode.TextDocument,
            range: vscode.Range,
            context: vscode.CodeActionContext,
        ): vscode.CodeAction[] {
            const actions: vscode.CodeAction[] = [];

            for (const diag of context.diagnostics) {
                if (diag.source !== DIAGNOSTIC_SOURCE) { continue; }

                const patternId = diag.code as string;
                const fixes = getQuickFixes(patternId, document, diag.range);

                for (const fix of fixes) {
                    const action = new vscode.CodeAction(
                        fix.title,
                        vscode.CodeActionKind.QuickFix,
                    );
                    action.diagnostics = [diag];
                    action.edit = fix.edit;
                    action.isPreferred = fix.isPreferred;
                    actions.push(action);
                }
            }

            return actions;
        },
    };
}

interface QuickFix {
    title: string;
    edit: vscode.WorkspaceEdit;
    isPreferred: boolean;
}

function getQuickFixes(
    patternId: string,
    document: vscode.TextDocument,
    range: vscode.Range,
): QuickFix[] {
    const lineText = document.lineAt(range.start.line).text;
    const fixes: QuickFix[] = [];

    switch (patternId) {
        case 'CODE_COLLECT_001': {
            // Replace .collect() with .take(1000)
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, range, lineText.replace(/\.collect\s*\(\s*\)/, '.take(1000)'));
            fixes.push({
                title: 'Replace collect() with take(1000)',
                edit,
                isPreferred: true,
            });
            break;
        }

        case 'CODE_SHOW_001': {
            // Remove .show() call
            const edit = new vscode.WorkspaceEdit();
            const fullLine = new vscode.Range(range.start.line, 0, range.start.line + 1, 0);
            edit.delete(document.uri, fullLine);
            fixes.push({
                title: 'Remove show() call',
                edit,
                isPreferred: false,
            });
            break;
        }

        case 'CODE_REPARTITION_001': {
            // Replace repartition(1) with coalesce(1)
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, range, lineText.replace(/\.repartition\s*\(\s*1\s*\)/, '.coalesce(1)'));
            fixes.push({
                title: 'Replace repartition(1) with coalesce(1) (avoids shuffle)',
                edit,
                isPreferred: true,
            });
            break;
        }

        case 'CODE_COUNT_001': {
            // Replace .count() > 0 with not df.isEmpty()
            const edit = new vscode.WorkspaceEdit();
            const replacement = lineText
                .replace(/(\w+)\.count\s*\(\s*\)\s*>\s*0/, 'not $1.isEmpty()')
                .replace(/(\w+)\.count\s*\(\s*\)\s*!=\s*0/, 'not $1.isEmpty()');
            edit.replace(document.uri, range, replacement);
            fixes.push({
                title: 'Replace count() > 0 with isEmpty()',
                edit,
                isPreferred: true,
            });
            break;
        }

        case 'CODE_DISPLAY_001': {
            // Remove display() call
            const edit = new vscode.WorkspaceEdit();
            const fullLine = new vscode.Range(range.start.line, 0, range.start.line + 1, 0);
            edit.delete(document.uri, fullLine);
            fixes.push({
                title: 'Remove display() call',
                edit,
                isPreferred: false,
            });
            break;
        }

        case 'CODE_JOIN_NO_BROADCAST_001':
        case 'JOIN_BROADCAST_001': {
            // Wrap join argument in broadcast()
            const joinArgMatch = lineText.match(/\.join\s*\(\s*(\w+)/);
            if (joinArgMatch) {
                const dfName = joinArgMatch[1];
                const edit = new vscode.WorkspaceEdit();

                // Replace .join(df_name with .join(broadcast(df_name)
                edit.replace(
                    document.uri,
                    range,
                    lineText.replace(
                        new RegExp(`\\.join\\s*\\(\\s*${escapeRegex(dfName)}`),
                        `.join(broadcast(${dfName})`,
                    ),
                );

                // Add broadcast import if not already present
                addBroadcastImport(edit, document);

                fixes.push({
                    title: `Wrap ${dfName} in broadcast()`,
                    edit,
                    isPreferred: true,
                });
            }
            break;
        }

        case 'CODE_TABLE_NO_STATS_001':
        case 'STATS_MISSING_001': {
            // Insert ANALYZE TABLE statement above the flagged line
            const tableMatch = lineText.match(/(?:spark\.table|spark\.read\.table)\s*\(\s*["']([^"']+)["']\s*\)/);
            if (tableMatch) {
                const tableName = tableMatch[1];
                const edit = new vscode.WorkspaceEdit();
                const insertPos = new vscode.Position(range.start.line, 0);
                const indent = lineText.match(/^(\s*)/)?.[1] || '';
                edit.insert(
                    document.uri,
                    insertPos,
                    `${indent}spark.sql("ANALYZE TABLE ${tableName} COMPUTE STATISTICS")\n`,
                );
                fixes.push({
                    title: `Add ANALYZE TABLE for ${tableName}`,
                    edit,
                    isPreferred: true,
                });
            }
            break;
        }
    }

    // Always offer a suppress action for every CatalystOps diagnostic
    const suppressEdit = new vscode.WorkspaceEdit();
    suppressEdit.insert(
        document.uri,
        document.lineAt(range.start.line).range.end,
        '  # noqa: catalystops',
    );
    fixes.push({
        title: 'Suppress: add # noqa: catalystops',
        edit: suppressEdit,
        isPreferred: false,
    });

    return fixes;
}

function addBroadcastImport(edit: vscode.WorkspaceEdit, document: vscode.TextDocument): void {
    const text = document.getText();

    // Check if broadcast is already imported
    if (/\bbroadcast\b/.test(text) && /from\s+pyspark/.test(text)) {
        return;
    }

    const lines = text.split('\n');

    // Look for existing "from pyspark.sql.functions import ..." line
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\s*from\s+pyspark\.sql\.functions\s+import\s+)(.+)$/);
        if (match) {
            const imports = match[2];
            if (!imports.includes('broadcast')) {
                // Append broadcast to existing import
                const newLine = `${match[1]}${imports.trimEnd()}, broadcast`;
                const lineRange = new vscode.Range(i, 0, i, lines[i].length);
                edit.replace(document.uri, lineRange, newLine);
            }
            return;
        }
    }

    // No existing import found — insert after the last import line
    let lastImportLine = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*(import\s|from\s)/.test(lines[i])) {
            lastImportLine = i;
        }
    }

    const insertLine = lastImportLine >= 0 ? lastImportLine + 1 : 0;
    edit.insert(
        document.uri,
        new vscode.Position(insertLine, 0),
        'from pyspark.sql.functions import broadcast\n',
    );
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
