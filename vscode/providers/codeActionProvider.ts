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
    }

    return fixes;
}
