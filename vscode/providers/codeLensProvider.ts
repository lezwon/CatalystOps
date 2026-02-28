/**
 * CodeLens provider - inline safety warnings above high-risk PySpark operations.
 */

import * as vscode from 'vscode';
import { estimateStaticCost } from '../analysis/staticCostEstimator';

/**
 * Create a CodeLens provider that shows safety warnings on high-risk PySpark operations.
 */
export function createCodeLensProvider(): vscode.CodeLensProvider {
    return {
        provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
            const lenses: vscode.CodeLens[] = [];
            const text = document.getText();
            const lines = text.split('\n');

            // Static cost estimate from @compute/@size annotations
            if (text.includes('@compute:')) {
                const costEstimate = estimateStaticCost(text);
                if (costEstimate) {
                    const { annotationLine } = costEstimate.computeSpec;
                    const line = lines[annotationLine] ?? '';
                    const range = new vscode.Range(annotationLine, 0, annotationLine, line.length);
                    const totalGB = costEstimate.totalDataGB.toFixed(1);
                    const rate = costEstimate.computeSpec.ratePerHour.toFixed(2);
                    lenses.push(new vscode.CodeLens(range, {
                        title: `$(circuit-board) Estimated cost: ${costEstimate.formattedCost}  (${totalGB} GB @ $${rate}/hr)`,
                        command: 'catalystops.analyzeCost',
                    }));
                }
            }

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
