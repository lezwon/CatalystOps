/**
 * CodeLens provider - inline cost annotations above joins/shuffles
 */

import * as vscode from 'vscode';

/**
 * Create a CodeLens provider that shows cost annotations on PySpark operations.
 */
export function createCodeLensProvider(): vscode.CodeLensProvider {
    return {
        provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
            const lenses: vscode.CodeLens[] = [];
            const text = document.getText();
            const lines = text.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Annotate .join() calls
                const joinMatch = line.match(/\.join\s*\(/);
                if (joinMatch) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(warning) Join operation - run CatalystOps to check join strategy',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // Annotate .crossJoin() calls
                const crossJoinMatch = line.match(/\.crossJoin\s*\(/);
                if (crossJoinMatch) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(error) Cross Join - Cost: 1000pts (Cartesian Product)',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // Annotate .collect()
                const collectMatch = line.match(/\.collect\s*\(\s*\)/);
                if (collectMatch) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(alert) collect() brings all data to driver - OOM risk',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // Annotate .repartition() and .coalesce()
                const repartMatch = line.match(/\.(?:repartition|coalesce)\s*\(\s*1\s*\)/);
                if (repartMatch) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(warning) Single partition - parallelism lost',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // Annotate .groupBy().agg() chains
                const groupByMatch = line.match(/\.groupBy\s*\(/);
                if (groupByMatch) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(info) GroupBy - triggers shuffle exchange',
                        command: 'catalystops.analyzeCost',
                    }));
                }
            }

            return lenses;
        },
    };
}
