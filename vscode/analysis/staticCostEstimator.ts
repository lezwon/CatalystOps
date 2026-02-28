/**
 * Static Cost Estimator - Estimates Spark job costs from source annotations.
 *
 * Reads # @compute: and # @size: annotations from Python files and produces
 * a dollar estimate without needing a live cluster connection.
 */

import { estimateDollarCostFromTableStats } from './costModel';

export interface ComputeSpec {
    nodes: number;
    cores: number;
    memoryGB: number;
    ratePerHour: number;
    annotationLine: number;   // 0-based line index, for CodeLens placement
}

export interface SizeAnnotation {
    varName: string | null;   // null if not attached to an assignment
    sizeBytes: number;
    annotationLine: number;
}

export interface StaticCostEstimate {
    computeSpec: ComputeSpec;
    annotations: SizeAnnotation[];
    totalDataGB: number;
    formattedCost: string;    // e.g. "~$0.0018"
    dollars: number;
}

/**
 * Parse the # @compute: annotation from source code.
 * Returns null if the annotation is absent or any required key is missing.
 */
export function parseComputeSpec(code: string): ComputeSpec | null {
    const match = /^#\s*@compute:\s*(.+)$/m.exec(code);
    if (!match) { return null; }

    const kvStr = match[1];
    const pairs: Record<string, string> = {};
    for (const part of kvStr.split(',')) {
        const eq = part.indexOf('=');
        if (eq === -1) { continue; }
        const key = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        pairs[key] = val;
    }

    const { nodes, cores, memory, rate } = pairs;
    if (!nodes || !cores || !memory || !rate) { return null; }

    const nodesNum = parseInt(nodes, 10);
    const coresNum = parseInt(cores, 10);
    const memoryGB = parseMemoryGB(memory);
    const rateNum = parseFloat(rate);

    if (isNaN(nodesNum) || isNaN(coresNum) || memoryGB === null || isNaN(rateNum)) { return null; }

    // Find the 0-based line index of the @compute annotation
    const annotationLine = code.slice(0, match.index).split('\n').length - 1;

    return {
        nodes: nodesNum,
        cores: coresNum,
        memoryGB,
        ratePerHour: rateNum,
        annotationLine,
    };
}

function parseMemoryGB(memStr: string): number | null {
    const m = /^(\d+(?:\.\d+)?)\s*(GB|MB|KB|TB)$/i.exec(memStr.trim());
    if (!m) { return null; }
    const value = parseFloat(m[1]);
    switch (m[2].toUpperCase()) {
        case 'TB': return value * 1024;
        case 'GB': return value;
        case 'MB': return value / 1024;
        case 'KB': return value / (1024 * 1024);
        default: return null;
    }
}

/**
 * Parse a size string like "50GB", "200MB" into bytes.
 * Returns 0 on parse failure.
 */
export function parseSizeBytes(sizeStr: string): number {
    const m = /^(\d+(?:\.\d+)?)\s*(GB|MB|KB|TB)$/i.exec(sizeStr.trim());
    if (!m) { return 0; }
    const value = parseFloat(m[1]);
    switch (m[2].toUpperCase()) {
        case 'TB': return value * 1024 * 1024 * 1024 * 1024;
        case 'GB': return value * 1024 * 1024 * 1024;
        case 'MB': return value * 1024 * 1024;
        case 'KB': return value * 1024;
        default: return 0;
    }
}

/**
 * Parse all # @size: annotations from source code.
 * Associates each annotation with a variable name if found on the same line
 * or the line immediately below.
 */
export function parseSizeAnnotations(code: string): SizeAnnotation[] {
    const lines = code.split('\n');
    const annotations: SizeAnnotation[] = [];
    const sizeRegex = /#\s*@size:\s*(\S+)/g;

    let match: RegExpExecArray | null;
    while ((match = sizeRegex.exec(code)) !== null) {
        const sizeStr = match[1];
        const sizeBytes = parseSizeBytes(sizeStr);

        // Determine which line this annotation is on (0-based)
        const beforeMatch = code.slice(0, match.index);
        const annotationLine = beforeMatch.split('\n').length - 1;

        // Try to find a variable assignment: same line first, then next line
        let varName: string | null = null;

        const sameLine = lines[annotationLine] ?? '';
        const sameLineAssign = /(\w+)\s*=/.exec(sameLine);
        if (sameLineAssign) {
            varName = sameLineAssign[1];
        } else {
            const nextLine = lines[annotationLine + 1] ?? '';
            const nextLineAssign = /(\w+)\s*=/.exec(nextLine);
            if (nextLineAssign) {
                varName = nextLineAssign[1];
            }
        }

        annotations.push({ varName, sizeBytes, annotationLine });
    }

    return annotations;
}

/**
 * Estimate the dollar cost of a Spark job from static annotations in source code.
 * Returns null if there is no # @compute: annotation in the code.
 */
export function estimateStaticCost(code: string): StaticCostEstimate | null {
    // Fast exit: no @compute annotation present
    if (!code.includes('# @compute:') && !/^#\s*@compute:/m.test(code)) { return null; }

    const computeSpec = parseComputeSpec(code);
    if (!computeSpec) { return null; }

    const annotations = parseSizeAnnotations(code);
    const totalBytes = annotations.reduce((sum, a) => sum + a.sizeBytes, 0);
    const totalDataGB = totalBytes / (1024 * 1024 * 1024);

    const estimate = estimateDollarCostFromTableStats(totalBytes, computeSpec.ratePerHour);
    const dollars = estimate.dollars ?? 0;

    return {
        computeSpec,
        annotations,
        totalDataGB,
        formattedCost: estimate.formatted,
        dollars,
    };
}
