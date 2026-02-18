/**
 * CodeLens provider - inline cost annotations above joins/shuffles.
 *
 * Before dry run: shows static estimates like [Cost: ~50pts - SortMergeJoin?]
 * After dry run:  shows real dollar estimates like [Est. Cost: $4.50/run - SortMergeJoin]
 */

import * as vscode from 'vscode';
import { COST_WEIGHTS } from '../models/constants';
import { getAllLineCosts, onCacheUpdated } from '../analysis/analysisCache';

/**
 * Create a CodeLens provider that shows cost annotations on PySpark operations.
 * Refreshes when the analysis cache updates.
 */
export function createCodeLensProvider(): vscode.CodeLensProvider {
    const _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    onCacheUpdated(() => _onDidChangeCodeLenses.fire());

    return {
        onDidChangeCodeLenses: _onDidChangeCodeLenses.event,

        provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
            const lenses: vscode.CodeLens[] = [];
            const text = document.getText();
            const lines = text.split('\n');
            const docUri = document.uri.toString();
            const cachedCosts = getAllLineCosts(docUri);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const cached = cachedCosts?.get(i);

                // Annotate .join() calls
                if (/\.join\s*\(/.test(line)) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    if (cached?.dollarEstimate) {
                        lenses.push(new vscode.CodeLens(range, {
                            title: `$(sparkle) Est. Cost: ${cached.dollarEstimate}/run - ${cached.joinType || 'Join'}`,
                            command: 'catalystops.analyzeCost',
                        }));
                    } else if (cached) {
                        lenses.push(new vscode.CodeLens(range, {
                            title: `$(info) Cost: ~${cached.costPoints}pts - ${cached.joinType || 'Join'}`,
                            command: 'catalystops.analyzeCost',
                        }));
                    } else {
                        lenses.push(new vscode.CodeLens(range, {
                            title: `$(warning) Cost: ~${COST_WEIGHTS.sortMergeJoin}pts - SortMergeJoin?`,
                            command: 'catalystops.analyzeCost',
                        }));
                    }
                }

                // Annotate .crossJoin() calls
                if (/\.crossJoin\s*\(/.test(line)) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    if (cached?.dollarEstimate) {
                        lenses.push(new vscode.CodeLens(range, {
                            title: `$(error) Est. Cost: ${cached.dollarEstimate}/run - CartesianProduct`,
                            command: 'catalystops.analyzeCost',
                        }));
                    } else {
                        lenses.push(new vscode.CodeLens(range, {
                            title: `$(error) Cost: ~${COST_WEIGHTS.cartesianProduct}pts - CartesianProduct`,
                            command: 'catalystops.analyzeCost',
                        }));
                    }
                }

                // Annotate .collect()
                if (/\.collect\s*\(\s*\)/.test(line)) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(alert) collect() brings all data to driver - OOM risk',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // Annotate .repartition(1) and .coalesce(1)
                if (/\.(?:repartition|coalesce)\s*\(\s*1\s*\)/.test(line)) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    lenses.push(new vscode.CodeLens(range, {
                        title: '$(warning) Single partition - parallelism lost',
                        command: 'catalystops.analyzeCost',
                    }));
                }

                // Annotate .groupBy().agg() chains
                if (/\.groupBy\s*\(/.test(line)) {
                    const range = new vscode.Range(i, 0, i, line.length);
                    if (cached?.dollarEstimate) {
                        lenses.push(new vscode.CodeLens(range, {
                            title: `$(info) Est. Cost: ${cached.dollarEstimate}/run - shuffle exchange`,
                            command: 'catalystops.analyzeCost',
                        }));
                    } else {
                        lenses.push(new vscode.CodeLens(range, {
                            title: `$(info) Cost: ~${COST_WEIGHTS.exchange}pts - shuffle exchange`,
                            command: 'catalystops.analyzeCost',
                        }));
                    }
                }
            }

            return lenses;
        },
    };
}
