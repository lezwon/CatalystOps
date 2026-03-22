/**
 * Plan Tree Builder - Parses physical plan text into a navigable PlanNode tree.
 * Each node is annotated with matching PlanIssue and source line from dfLineMap.
 */

import { AnalysisResult } from '../models/types';
import { PlanIssue } from './planParser';

export interface PlanNode {
    id: string;
    operatorName: string;
    details: string;       // Human-readable subtitle: filter condition, join keys, group-by cols, etc.
    rawLine: string;
    depth: number;
    children: PlanNode[];
    issue?: PlanIssue;
    severity: 'critical' | 'warning' | 'info' | 'none';
    sourceLine?: number;
    dataframeName?: string;
}

const CRITICAL_OPS = [
    'SortMergeJoin', 'CartesianProduct', 'BroadcastNestedLoop', 'BroadcastJoinSinglePartition',
];
const WARNING_OPS = ['Exchange', 'SortAggregate'];
const INFO_OPS = ['BroadcastHashJoin'];

/**
 * Metadata/property continuation lines that belong to the preceding operator.
 * In Spark's formatted explain, these appear as indented lines without +- markers
 * and should not be rendered as separate DAG nodes.
 */
// Condition / Left keys / Right keys are NOT here — they are captured and attached to nodes.
const METADATA_LINE_RE = /^(Output|Batched|Location|PushedFilters|PartitionFilters|ReadSchema|DataFilters|Format|SelectedBucketsCount|Arguments|Join type|Number of output rows|SubqueryAlias|TableName|Input)\s*[:[\(]/i;

/** Metadata keys whose values are surfaced as node detail text. */
const CAPTURE_META_RE = /^(Condition|Left keys|Right keys)\s*[:\(]/i;

/**
 * Format-conversion / AQE-bookkeeping operators that add noise without
 * meaningful information. These are single-child wrappers that are safe to
 * reparent: when skipped, their children are attached to their grandparent.
 * Only depth > 0 nodes should be in this set (root-level nodes cannot be
 * reparented and must remain in the tree for structural correctness).
 */
const SKIP_OPERATORS = new Set([
    'ColumnarToRow', 'RowToColumnar', 'InputAdapter', 'AQEShuffleRead',
    'InputIteratorTransformer', 'AdaptiveSparkPlan', 'QueryStageInput',
    'ReusedExchange', 'WholeStageCodegen',
]);

/** Human-readable labels for Spark physical plan operator names. */
const FRIENDLY_NAMES: Record<string, string> = {
    FileScan: 'Read',
    PhotonScan: 'Read',
    Scan: 'Read',
    LocalTableScan: 'Local Data',
    Exchange: 'Shuffle',
    HashAggregate: 'Aggregate',
    SortAggregate: 'Aggregate',
    ObjectHashAggregate: 'Aggregate',
    BroadcastHashJoin: 'Hash Join',
    SortMergeJoin: 'Sort-Merge Join',
    ShuffledHashJoin: 'Hash Join',
    BroadcastNestedLoopJoin: 'Nested Join',
    CartesianProduct: 'Cartesian Product',
    BroadcastExchange: 'Broadcast',
    Filter: 'Filter',
    Project: 'Select',
    Sort: 'Sort',
    Window: 'Window',
    Union: 'Union',
    TakeOrderedAndProject: 'Top-N',
    Limit: 'Limit',
    Generate: 'Explode',
    Expand: 'Expand',
    Deduplicate: 'Distinct',
    Output: 'Output',
};

export function getSeverity(operatorName: string): 'critical' | 'warning' | 'info' | 'none' {
    if (CRITICAL_OPS.some(op => operatorName.includes(op))) { return 'critical'; }
    if (WARNING_OPS.some(op => operatorName.includes(op))) { return 'warning'; }
    if (INFO_OPS.some(op => operatorName.includes(op))) { return 'info'; }
    return 'none';
}

function findMatchingIssue(operatorName: string, planIssues: PlanIssue[]): PlanIssue | undefined {
    return planIssues.find(issue =>
        issue.name === operatorName ||
        operatorName.includes(issue.name) ||
        issue.name.includes(operatorName),
    );
}

/**
 * Parse a single plan line into depth and content.
 *
 * Depth algorithm — handles two plan formats emitted by Spark/Databricks:
 *
 * Format A (classic tree markers):
 *   +- *(N) Operator   → depth = floor(markerPos / 3) + 1
 *   :-  ...            → same
 *
 * Format B (AQE / Databricks — indented, no +- marker):
 *   "   *(2) Filter"   → depth = floor(leadingSpaces / 3)
 *   Both formats use 3-space indentation per level.
 *
 * Lines that are section headers (== ... ==) or metadata properties
 * (Output:, Batched:, Location:, Input [...], etc.) are skipped.
 */
type ParsedLine =
    | { depth: number; content: string; metaKey?: undefined }
    | { depth: number; content: string; metaKey: string }
    | null;

function parseLine(line: string): ParsedLine {
    const trimmed = line.trim();
    if (!trimmed || /^==\s/.test(trimmed)) { return null; }

    let pos = line.indexOf('+- ');
    if (pos < 0) { pos = line.indexOf(':- '); }

    let depth: number;
    let rawContent: string;

    if (pos >= 0) {
        depth = Math.floor(pos / 3) + 1;
        rawContent = line.slice(pos + 3).trim();
        // Skip section headers embedded in the tree (e.g. "+- == Final Plan ==")
        if (/^==\s/.test(rawContent)) { return null; }
    } else {
        // No branch marker — use leading-space indentation for depth (Format B).
        const indent = line.length - line.trimStart().length;
        depth = Math.floor(indent / 3);
        rawContent = trimmed;
    }

    // Skip bare codegen stage markers with no operator (e.g. "*(1)" or "*(1) " alone)
    if (/^\*?\s*\(\d+\)\s*$/.test(rawContent)) { return null; }

    // Strip codegen prefix: *(N), * (N), or (N) — allow space between * and (
    const content = rawContent
        .replace(/^\*\s*\(\d+\)\s+/, '')   // * (N) or *(N) followed by operator
        .replace(/^\(\d+\)\s+/, '')          // (N) alone
        .replace(/\[codegen id\s*:\s*\d+\]/gi, '')  // [codegen id : N] noise
        .trim();

    // Capture high-value metadata lines (Condition, join keys) — attach to node
    const captureMeta = CAPTURE_META_RE.exec(content);
    if (captureMeta) {
        return { depth, content, metaKey: captureMeta[1] };
    }

    // Skip other metadata/property continuation lines
    if (METADATA_LINE_RE.test(content)) { return null; }

    return { depth, content: content || rawContent };
}

/** Strip Spark internal attribute suffixes: `col_name#123L` → `col_name` */
function cleanRefs(s: string): string {
    return s
        .replace(/#\d+L?\b/g, '')          // col#123L → col
        .replace(/\bNULLS (FIRST|LAST)\b/gi, '')  // remove NULLS FIRST/LAST
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Truncate a string to max length, appending ellipsis. */
function trunc(s: string, max = 38): string {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Convert raw Spark predicate expressions into plain English.
 * e.g. "isnotnull(add.dataChange) && (size > 0)" → "add.dataChange not null and size > 0"
 */
function humanizeCondition(raw: string): string {
    return cleanRefs(raw)
        // strip outer parens wrapping the whole expression
        .replace(/^\((.*)\)$/, '$1')
        // null checks — dotted paths like add.dataChange
        .replace(/isnotnull\(([\w.]+)\)/gi, '$1 not null')
        .replace(/isnull\(([\w.]+)\)/gi, '$1 is null')
        // logical operators
        .replace(/\s*&&\s*/g, ' and ')
        .replace(/\s*\|\|\s*/g, ' or ')
        // comparison sugar
        .replace(/\bequalTo\(([\w.]+),\s*([\w.'"-]+)\)/gi, '$1 = $2')
        .replace(/\bgreaterThan\(([\w.]+),\s*([\w.'"-]+)\)/gi, '$1 > $2')
        .replace(/\blessThan\(([\w.]+),\s*([\w.'"-]+)\)/gi, '$1 < $2')
        // strip remaining internal parens around simple expressions
        .replace(/\(([^()]+)\)/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Extract a short, human-readable subtitle from the raw plan line.
 * Returns empty string when nothing meaningful can be extracted.
 */
function extractDetails(rawOperator: string, content: string): string {
    // ── Filter ─────────────────────────────────────────────────────────────
    if (/^Filter$/i.test(rawOperator)) {
        const cond = content.replace(/^Filter\s*/i, '');
        return trunc(humanizeCondition(cond), 52);
    }

    // ── Joins ───────────────────────────────────────────────────────────────
    if (/Join/i.test(rawOperator)) {
        // "[left_key], [right_key], JoinType"
        const m = content.match(/\[([^\]]+)\].*?\[([^\]]+)\].*?(Inner|Left(?:Semi|Anti)?|Right|Full(?:Outer)?|Cross)/i);
        if (m) {
            const lk = cleanRefs(m[1].split(',')[0]);
            const rk = cleanRefs(m[2].split(',')[0]);
            return trunc(`${lk} = ${rk}  (${m[3]})`);
        }
        // CartesianProduct / cross join with no keys
        const jt = content.match(/(Inner|Left|Right|Full|Cross)/i);
        return jt ? `(${jt[1]})` : '';
    }

    // ── Aggregate ───────────────────────────────────────────────────────────
    if (/Aggregate/i.test(rawOperator)) {
        const km = content.match(/keys=\[([^\]]*)\]/i);
        const fm = content.match(/functions=\[([^\]]+)\]/i);
        const keys = km ? cleanRefs(km[1]) : '';
        const fns  = fm ? cleanRefs(fm[1])
            .replace(/,\s*mergeSupportedType=\w+/gi, '')
            .replace(/partial_/gi, '') : '';
        const groupBy = keys ? `GROUP BY ${trunc(keys, 24)}` : 'global';
        const aggs = fns ? trunc(fns, 24) : '';
        return aggs ? `${groupBy}\n${aggs}` : groupBy;
    }

    // ── Exchange / Shuffle ──────────────────────────────────────────────────
    if (/^Exchange$/i.test(rawOperator)) {
        const pm = content.match(/hashpartitioning\(([^,)]+)/i);
        if (pm) { return `PARTITION BY ${cleanRefs(pm[1])}`; }
        if (/SinglePartition/i.test(content)) { return 'single partition (bottleneck)'; }
        if (/RoundRobin/i.test(content))      { return 'round-robin'; }
        return '';
    }

    // ── Sort ────────────────────────────────────────────────────────────────
    if (/^Sort$/i.test(rawOperator)) {
        const sm = content.match(/\[([^\]]+)\]/);
        if (sm) {
            const keys = cleanRefs(sm[1])
                .replace(/\b(ASC|DESC)\b/gi, k => k.toUpperCase());
            return trunc(`ORDER BY ${keys}`);
        }
        return '';
    }

    // ── Project / Select ────────────────────────────────────────────────────
    if (/^Project$/i.test(rawOperator)) {
        const cm = content.match(/\[([^\]]+)\]/);
        if (cm) {
            const cols = cleanRefs(cm[1]).split(',').map(c => c.split(' AS ').pop()!.trim());
            const preview = cols.slice(0, 4).join(', ');
            return cols.length > 4 ? `${preview}, +${cols.length - 4} more` : preview;
        }
        return '';
    }

    // ── Window ──────────────────────────────────────────────────────────────
    if (/^Window$/i.test(rawOperator)) {
        const pm = content.match(/windowspecdefinition\(([^,]+(?:,[^,]+)*?),\s*(?:ASC|DESC|specifiedwindowframe)/i);
        if (pm) {
            const partCols = pm[1].split(',').map(c => cleanRefs(c)).filter(Boolean);
            return partCols.length ? `PARTITION BY ${partCols.join(', ')}` : 'global window';
        }
        return 'global window';
    }

    // ── LocalTableScan ──────────────────────────────────────────────────────
    if (/^LocalTableScan$/i.test(rawOperator)) {
        const cm = content.match(/\[([^\]]+)\]/);
        if (cm) {
            const cols = cleanRefs(cm[1]).split(',').map(c => c.trim()).filter(Boolean);
            const preview = cols.slice(0, 4).join(', ');
            return cols.length > 4 ? `${preview}, +${cols.length - 4} more` : preview;
        }
        return 'in-memory data';
    }

    return '';
}

let nodeCounter = 0;

// Regex matching real operator tokens — used to detect whether a Final Plan section exists.
const REAL_OPERATOR_RE = /(?:FileScan|PhotonScan|\bScan\s+(?:parquet|delta|orc|json|csv)\b|SortMergeJoin|BroadcastHashJoin|BroadcastNestedLoopJoin|Exchange\b|HashAggregate|SortAggregate)/i;

function buildTree(
    physicalPlan: string,
    planIssues: PlanIssue[],
    dataframeName: string | undefined,
    sourceLine: number | undefined,
): PlanNode[] {
    const roots: PlanNode[] = [];
    const stack: (PlanNode | undefined)[] = [];

    // Only skip the Initial Plan section when a real Final Plan exists before it.
    // Plans where the entire body is under == Initial Plan == should be analysed.
    const initialPlanStart = physicalPlan.search(/==\s*Initial Plan\s*==/i);
    const hasFinalPlan = initialPlanStart > -1
        ? REAL_OPERATOR_RE.test(physicalPlan.substring(0, initialPlanStart))
        : false;

    let inInitialPlan = false;

    for (const line of physicalPlan.split('\n')) {
        if (/==\s*Initial Plan\s*==/i.test(line)) { inInitialPlan = true; }
        if (inInitialPlan && hasFinalPlan) { continue; }

        const parsed = parseLine(line);
        if (!parsed) { continue; }

        const { depth, content } = parsed;

        // Attach captured metadata (Condition, join keys) to the most recent node at this depth
        if (parsed.metaKey) {
            const targetNode = stack[depth] ?? stack[depth - 1];
            if (targetNode && !targetNode.details) {
                const val = content.replace(/^[^:\(]+[:\(]\s*/, '').trim();
                if (parsed.metaKey.toLowerCase() === 'condition') {
                    targetNode.details = trunc(humanizeCondition(val), 52);
                } else {
                    // Left keys / Right keys — append as join keys
                    const existing = targetNode.details ? `${targetNode.details}  ` : '';
                    targetNode.details = trunc(`${existing}${parsed.metaKey}: ${cleanRefs(val)}`, 60);
                }
            }
            continue;
        }

        const rawOperator = content.split(/[\s[(,]/)[0] || content;

        // Skip single-child wrapper operators (format conversions, AQE bookkeeping).
        // Reparent their children to their grandparent so the tree stays connected.
        if (SKIP_OPERATORS.has(rawOperator) && depth > 0) {
            // Point this depth slot to the parent so children adopt the grandparent.
            stack[depth] = stack[depth - 1];
            stack.length = depth + 1;
            continue;
        }

        // Map to a human-readable label — exact match first to avoid LocalTableScan → Scan confusion
        let friendlyName = FRIENDLY_NAMES[rawOperator]
            ?? Object.entries(FRIENDLY_NAMES).find(([k]) => rawOperator.includes(k))?.[1]
            ?? rawOperator;

        // Append table/source name to Read nodes so "Read" becomes "Read: orders"
        if (friendlyName === 'Read') {
            const tableMatch = content.match(/(?:FileScan|PhotonScan|Scan)\s+\w+\s+([\w.]+)/i);
            if (tableMatch) {
                const shortName = tableMatch[1].split('.').slice(-1)[0];
                friendlyName = `Read: ${shortName}`;
            }
        }
        const issue = findMatchingIssue(rawOperator, planIssues);

        const node: PlanNode = {
            id: `node-${nodeCounter++}`,
            operatorName: friendlyName,
            details: extractDetails(rawOperator, content),
            rawLine: content,
            depth,
            children: [],
            issue,
            severity: getSeverity(rawOperator),
            dataframeName,
            // Only root nodes (depth=0) carry the DataFrame source line
            sourceLine: depth === 0 ? sourceLine : undefined,
        };

        if (depth === 0) {
            roots.push(node);
            stack.length = 0;
            stack[0] = node;
        } else {
            const parent = stack[depth - 1];
            if (parent) {
                parent.children.push(node);
            }
            stack[depth] = node;
            stack.length = depth + 1;
        }
    }

    return roots;
}

/**
 * Build PlanNode trees from all analysis results.
 *
 * @param results   - Cached analysis results (each has executionPlan.physicalPlan)
 * @param planIssues - Plan issues for annotation
 * @param dfLineMap  - Maps dataframeName → 0-based source line in Python file
 */
export function buildPlanTrees(
    results: AnalysisResult[],
    planIssues: PlanIssue[],
    dfLineMap: Map<string, number>,
): PlanNode[] {
    nodeCounter = 0;
    const allRoots: PlanNode[] = [];

    for (const result of results) {
        if (!result.executionPlan?.physicalPlan) { continue; }
        const sourceLine = result.dataframeName
            ? dfLineMap.get(result.dataframeName)
            : undefined;
        const roots = buildTree(
            result.executionPlan.physicalPlan,
            planIssues,
            result.dataframeName,
            sourceLine,
        );
        allRoots.push(...roots);
    }

    return allRoots;
}
