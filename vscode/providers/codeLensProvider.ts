/**
 * CodeLens provider - inline safety warnings above high-risk PySpark operations.
 */

import * as vscode from 'vscode';

/**
 * Create a CodeLens provider that shows safety warnings on high-risk PySpark operations.
 */
export function createCodeLensProvider(): vscode.CodeLensProvider {
    return {
        provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
            const lenses: vscode.CodeLens[] = [];
            const lines = document.getText().split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const range = new vscode.Range(i, 0, i, line.length);

                // collect() — OOM risk
                if (/\.collect\s*\(\s*\)/.test(line)) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(alert) collect() — brings all data to driver, OOM risk',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // repartition(1) / coalesce(1) — parallelism loss
                if (/\.(?:repartition|coalesce)\s*\(\s*1\s*\)/.test(line)) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(warning) Single partition — parallelism lost',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // checkpoint() — expensive HDFS write
                if (/\.checkpoint\s*\(\s*\)/.test(line)) {
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(warning) checkpoint() writes full dataset to HDFS — consider .localCheckpoint()',
                        command: 'catalystops.analyzeCost',
                    }));
                }
            }

            return lenses;
        },
    };
}
