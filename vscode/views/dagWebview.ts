/**
 * Plan DAG WebviewPanel - Visual SVG graph of the physical plan.
 * Nodes are colored by severity; clicking a node reveals the source line.
 */

import * as vscode from 'vscode';
import { PlanNode } from '../analysis/planTreeBuilder';
import { PlanIssue } from '../analysis/planParser';
import { sendEvent } from '../telemetry';
import { fetchJobRunCost } from '../billing/billingFetcher';
import { getConnectionConfig } from '../config/settings';

let currentPanel: vscode.WebviewPanel | undefined;

export function showDagWebview(
    context: vscode.ExtensionContext,
    nodes: PlanNode[],
): void {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        currentPanel.webview.html = generateHtml(nodes);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'catalystops.planDag',
        'CatalystOps: Plan DAG',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
    );

    currentPanel.webview.html = generateHtml(nodes);

    currentPanel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'nodeClick' && typeof msg.sourceLine === 'number') {
            sendEvent('dag/node_click', { operator: String(msg.operator ?? '') });
            void vscode.commands.executeCommand('revealLine', {
                lineNumber: msg.sourceLine,
                at: 'center',
            });
        }
    }, undefined, context.subscriptions);

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    });
}

export function disposeDagWebview(): void {
    currentPanel?.dispose();
    currentPanel = undefined;
}

// ── Job Run DAG ──────────────────────────────────────────────────────────────

let currentJobRunPanel: vscode.WebviewPanel | undefined;

export function showJobRunDagWebview(
    context: vscode.ExtensionContext,
    nodes: PlanNode[],
    planIssues: PlanIssue[],
    jobName: string,
    run: { runId: number; jobId: number; startTimeMs: number; state: { life_cycle_state: string; result_state?: string }; durationMs?: number; clusterId?: string },
    sourceContent?: string,
    sourcePath?: string,
    rawPlans?: Array<{ description: string; physicalPlan: string }>,
): void {
    const title = `CatalystOps: ${jobName}`;

    const setupPanel = (panel: vscode.WebviewPanel) => {
        panel.webview.html = generateJobRunHtml(nodes, planIssues, jobName, run, !!sourceContent, rawPlans ?? []);

        panel.webview.onDidReceiveMessage(async msg => {
            if (msg.type === 'showSource' && sourceContent) {
                const lang = sourcePath?.endsWith('.py') ? 'python' : 'python';
                const doc = await vscode.workspace.openTextDocument({ content: sourceContent, language: lang });
                await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
            } else if (msg.type === 'getCost') {
                const config = getConnectionConfig();
                if (!config) {
                    void panel.webview.postMessage({ type: 'costResult', error: 'Databricks not configured.' });
                    return;
                }
                const confirm = await vscode.window.showInformationMessage(
                    'Fetching run cost queries system.billing.usage via a SQL warehouse. ' +
                    'If no warehouse is running, one will start automatically — this may take up to 2 minutes and incurs a small SQL compute charge.',
                    { modal: true },
                    'Fetch Cost',
                );
                if (confirm !== 'Fetch Cost') {
                    void panel.webview.postMessage({ type: 'costCancelled' });
                    return;
                }
                try {
                    const cost = await fetchJobRunCost(config, run.runId, run.jobId, run.startTimeMs);
                    if (cost) {
                        sendEvent('job_run/cost_fetched', { dollars: String(cost.dollars.toFixed(2)), dbus: String(cost.dbus.toFixed(2)), approximate: String(!!cost.approximate) });
                        void panel.webview.postMessage({ type: 'costResult', dollars: cost.dollars, dbus: cost.dbus, approximate: cost.approximate ?? false });
                    } else {
                        void panel.webview.postMessage({ type: 'costResult', error: 'No billing data found. Billing data can take up to 2 hours to appear — try again later.' });
                    }
                } catch (err) {
                    const msg2 = err instanceof Error ? err.message : String(err);
                    void panel.webview.postMessage({ type: 'costResult', error: msg2.substring(0, 120) });
                }
            }
        }, undefined, context.subscriptions);
    };

    if (currentJobRunPanel) {
        currentJobRunPanel.reveal(vscode.ViewColumn.Beside);
        currentJobRunPanel.title = title;
        setupPanel(currentJobRunPanel);
        return;
    }

    currentJobRunPanel = vscode.window.createWebviewPanel(
        'catalystops.jobRunDag',
        title,
        vscode.ViewColumn.Beside,
        { enableScripts: true },
    );

    setupPanel(currentJobRunPanel);

    currentJobRunPanel.onDidDispose(() => {
        currentJobRunPanel = undefined;
    }, undefined, context.subscriptions);
}

/** Operator icons for the clean tree view. */
const OP_ICONS: Record<string, string> = {
    'Read': '📖',
    'Local Data': '📦',
    'Filter': '🔍',
    'Select': '📋',
    'Aggregate': '📊',
    'Sort': '↕️',
    'Sort-Merge Join': '🔗',
    'Hash Join': '🔗',
    'Nested Join': '⚠️',
    'Cartesian Product': '⚠️',
    'Shuffle': '🔀',
    'Broadcast': '📡',
    'Window': '🪟',
    'Union': '🔁',
    'Explode': '💥',
    'Expand': '↔️',
    'Distinct': '✨',
    'Limit': '✂️',
    'Top-N': '🏆',
    'Output': '📤',
};

// Operators that carry no useful information when appearing as the sole node in a plan
const NOISE_OPS = new Set([
    'ColumnarToRow', 'RowToColumnar', 'InputAdapter', 'AQEShuffleRead',
    'InputIteratorTransformer', 'AdaptiveSparkPlan', 'WholeStageCodegen',
    'QueryStageInput', 'ReusedExchange',
]);

/** True if the plan rooted at `node` has nothing interesting to show. */
function isTrivialPlan(node: PlanNode): boolean {
    // Single node that is a noise wrapper or a bare read with no details
    if (node.children.length === 0) {
        if (NOISE_OPS.has(node.operatorName)) { return true; }
        if (node.operatorName === 'Read' || node.operatorName === 'Local Data') { return true; }
        if (node.operatorName.startsWith('Read:')) { return true; }
        return false;
    }
    // A single-child chain where every node is trivial
    if (node.children.length === 1) {
        return (NOISE_OPS.has(node.operatorName) || node.operatorName.startsWith('Read')) &&
            isTrivialPlan(node.children[0]);
    }
    return false;
}

function opIcon(operatorName: string): string {
    for (const [key, icon] of Object.entries(OP_ICONS)) {
        if (operatorName.startsWith(key)) { return icon; }
    }
    return '⬡';
}

/**
 * Render a PlanNode as an HTML tree row.
 * connector: the ASCII-art prefix for this level (e.g. "│  ├─ ")
 * isLast: whether this node is the last child of its parent (controls ├─ vs └─)
 */
function renderTreeNode(node: PlanNode, isRoot: boolean, prefix = '', isLast = true): string {
    const sevClass = `sev-${node.severity}`;
    const icon = opIcon(node.operatorName);
    const detailHtml = node.details
        ? ` <span class="node-detail">${escapeHtml(node.details.replace(/\n/g, '  '))}</span>`
        : '';

    let connector: string;
    let childPrefix: string;
    if (isRoot) {
        connector = '';
        childPrefix = '';
    } else {
        connector = prefix + (isLast ? '└─ ' : '├─ ');
        childPrefix = prefix + (isLast ? '   ' : '│  ');
    }

    const badge = `<span class="node-badge ${sevClass}" title="${escapeHtml(node.rawLine)}">
        <span>${icon}</span>
        <span class="node-name">${escapeHtml(node.operatorName)}</span>${detailHtml}
    </span>`;

    const rowHtml = `<div class="tree-row">
        <span class="tree-connector">${escapeHtml(connector)}</span>${badge}
    </div>`;

    let childrenHtml = '';
    if (node.children.length > 0) {
        childrenHtml = node.children.map((child, i) =>
            renderTreeNode(child, false, childPrefix, i === node.children.length - 1),
        ).join('');
    }

    return `<div class="tree-node">${rowHtml}${childrenHtml}</div>`;
}

function generateJobRunHtml(
    roots: PlanNode[],
    planIssues: PlanIssue[],
    jobName: string,
    run: { runId: number; jobId: number; startTimeMs: number; state: { life_cycle_state: string; result_state?: string }; durationMs?: number; clusterId?: string },
    hasSource: boolean,
    rawPlans: Array<{ description: string; physicalPlan: string }>,
): string {
    // Verdict banner
    const criticalIssues = planIssues.filter(p => p.costPoints >= 80);
    const warningIssues  = planIssues.filter(p => p.costPoints >= 30 && p.costPoints < 80);

    let verdictBg: string;
    let verdictText: string;
    if (criticalIssues.length > 0) {
        verdictBg = '#742a2a';
        verdictText = `⚠️ ${planIssues.length} optimization${planIssues.length !== 1 ? 's' : ''} available`;
    } else if (warningIssues.length > 0) {
        verdictBg = '#744210';
        verdictText = `⚠️ ${planIssues.length} optimization${planIssues.length !== 1 ? 's' : ''} available`;
    } else {
        verdictBg = '#1a4731';
        verdictText = '✅ Running efficiently';
    }

    const state = run.state.life_cycle_state;
    const result = run.state.result_state;
    const statusIcon = result === 'SUCCESS' ? '✅' : result === 'FAILED' ? '❌' : '⏺';
    const statusText = `${statusIcon} ${state}${result ? ` (${result})` : ''}`;
    const clusterText = run.clusterId ?? 'serverless';

    // Tree view — grouped by description, collapsible
    let planTreeHtml: string;
    if (roots.length === 0) {
        planTreeHtml = `<p style="color:#a0aec0;padding:20px">No execution plans found for this run.</p>`;
    } else {
        // Group roots by description (dataframeName)
        const groups = new Map<string, PlanNode[]>();
        for (const root of roots) {
            const key = root.dataframeName ?? 'Execution';
            if (!groups.has(key)) { groups.set(key, []); }
            groups.get(key)!.push(root);
        }

        let totalTrivialHidden = 0;
        const groupHtmlParts: string[] = [];

        for (const [desc, groupRoots] of groups) {
            const interesting = groupRoots.filter(r => !isTrivialPlan(r));
            const trivialCount = groupRoots.length - interesting.length;
            totalTrivialHidden += trivialCount;

            if (interesting.length === 0) { continue; }

            // Render each plan tree in this group
            const treesHtml = interesting.map((root, i) => {
                const numLabel = interesting.length > 1
                    ? `<span class="exec-num">Stage ${i + 1}</span>` : '';
                return `<div class="exec-plan">${numLabel}${renderTreeNode(root, true)}</div>`;
            }).join('\n');

            // Open by default if only 1 group; collapse if many groups
            const openAttr = groups.size === 1 ? ' open' : '';
            const countTag = `<span class="group-count">${groupRoots.length} execution${groupRoots.length !== 1 ? 's' : ''}${trivialCount > 0 ? `, ${trivialCount} read-only` : ''}</span>`;

            groupHtmlParts.push(`<details class="plan-group"${openAttr}>
                <summary class="plan-summary"><span class="plan-desc">${escapeHtml(desc)}</span>${countTag}</summary>
                <div class="plan-trees">${treesHtml}</div>
            </details>`);
        }

        const trivialNote = totalTrivialHidden > 0
            ? `<div class="trivial-summary">${totalTrivialHidden} read-only execution${totalTrivialHidden !== 1 ? 's' : ''} hidden</div>`
            : '';

        planTreeHtml = groupHtmlParts.length > 0
            ? `<div class="plan-tree">${groupHtmlParts.join('\n')}${trivialNote}</div>`
            : `<p style="color:#a0aec0;padding:8px 0">${totalTrivialHidden} execution${totalTrivialHidden !== 1 ? 's' : ''} found — all are simple read operations with no optimization opportunities.</p>`;
    }

    // Suggestion cards
    const cardsSvg = planIssues.map(pi => {
        const icon = pi.costPoints >= 80 ? '🔴' : pi.costPoints >= 30 ? '🟡' : '🔵';
        const tableLabel = pi.tableName
            ? `<span style="font-size:11px;color:#718096;margin-top:4px;display:block">table: ${escapeHtml(pi.tableName)}</span>`
            : '';
        // Preserve newlines in description as <br> + code formatting for indented lines
        const descHtml = escapeHtml(pi.description)
            .replace(/\n(\s{2,})/g, '<br><code style="font-size:12px;color:#81e6d9">$1</code>')
            .replace(/\n/g, '<br>');
        return `<div style="background:#2d3748;border-radius:8px;padding:14px 18px;margin-bottom:10px">
            <div style="font-weight:bold;color:#e2e8f0;margin-bottom:4px">${icon} ${escapeHtml(pi.name)}</div>
            <div style="color:#a0aec0;font-size:13px;line-height:1.6">${descHtml}</div>
            ${tableLabel}
        </div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(jobName)}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #1e1e1e; color: #e2e8f0; font-family: -apple-system, sans-serif; overflow: auto; }
        .verdict { padding: 12px 20px; font-size: 15px; font-weight: bold; border-bottom: 1px solid #2d3748; }
        .meta { padding: 8px 20px; font-size: 12px; color: #718096; border-bottom: 1px solid #2d3748; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .meta-text { flex: 1; }
        .btn-source, .btn-cost {
            padding: 4px 12px; border-radius: 4px; border: 1px solid #4a5568;
            background: #2d3748; color: #a0aec0; font-size: 12px; cursor: pointer;
            white-space: nowrap; flex-shrink: 0;
        }
        .btn-source:hover, .btn-cost:hover { background: #3a4a5c; color: #e2e8f0; border-color: #718096; }
        .btn-cost:disabled { opacity: 0.5; cursor: default; }
        #cost-display { font-size: 12px; color: #68d391; white-space: nowrap; }
        .dag-section { padding: 16px 20px; }
        .dag-section h3 { color: #a0aec0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
        .cards-section { padding: 0 20px 20px; }
        .cards-section h3 { color: #a0aec0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
        .raw-section { padding: 0 20px 24px; }
        .raw-summary {
            cursor: pointer; font-size: 12px; text-transform: uppercase;
            letter-spacing: 0.05em; color: #4a5568; padding: 4px 0; list-style: none;
        }
        .raw-summary::-webkit-details-marker { display: none; }
        .raw-summary::before { content: '▶  '; font-size: 10px; }
        details[open] > .raw-summary::before { content: '▼  '; }
        .raw-plans { margin-top: 10px; display: flex; flex-direction: column; gap: 12px; }
        .raw-plan-label { font-size: 11px; color: #718096; margin-bottom: 4px; font-family: -apple-system, sans-serif; }
        .raw-plan-text {
            background: #141920; border: 1px solid #2d3748; border-radius: 4px;
            padding: 12px 14px; font-size: 11px; color: #68d391; font-family: ui-monospace, monospace;
            white-space: pre; overflow-x: auto; line-height: 1.6; max-height: 300px; overflow-y: auto;
        }
        /* Plan tree styles */
        .plan-tree { font-family: ui-monospace, monospace; font-size: 15px; }
        .plan-group { margin-bottom: 14px; border: 1px solid #2d3748; border-radius: 8px; overflow: hidden; }
        .plan-group[open] > .plan-trees { padding: 16px 18px; }
        .plan-summary {
            display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
            cursor: pointer; padding: 12px 16px;
            background: #242c3a; border-radius: 8px;
            list-style: none; user-select: none;
        }
        .plan-summary::-webkit-details-marker { display: none; }
        .plan-group[open] > .plan-summary { border-bottom: 1px solid #2d3748; border-radius: 8px 8px 0 0; }
        .plan-summary::before {
            content: '▶'; font-size: 11px; color: #718096; flex-shrink: 0; margin-right: 2px;
        }
        .plan-group[open] > .plan-summary::before { content: '▼'; }
        .plan-desc {
            font-size: 14px; color: #e2e8f0; font-family: -apple-system, sans-serif;
            white-space: normal; word-break: break-word; line-height: 1.5;
        }
        .group-count { font-size: 12px; color: #718096; white-space: nowrap; flex-shrink: 0; }
        .exec-plan { margin-bottom: 16px; }
        .exec-plan:last-child { margin-bottom: 0; }
        .exec-num { display: block; font-size: 12px; color: #718096; margin-bottom: 6px; font-family: -apple-system, sans-serif; }
        .trivial-summary { font-size: 12px; color: #4a5568; padding: 8px 4px; font-style: italic; }
        .tree-node { display: flex; flex-direction: column; }
        .tree-row { display: flex; align-items: flex-start; padding: 3px 0; }
        .tree-connector { color: #4a5568; white-space: pre; flex-shrink: 0; line-height: 2; font-size: 15px; }
        .node-badge {
            display: inline-flex; align-items: center; gap: 8px;
            padding: 6px 14px; border-radius: 6px; cursor: default;
            white-space: normal; word-break: break-word; line-height: 1.5; max-width: 100%;
        }
        .node-badge:hover { filter: brightness(1.15); }
        .node-badge.sev-critical { background: #742a2a; border-left: 4px solid #e53e3e; }
        .node-badge.sev-warning  { background: #744210; border-left: 4px solid #dd6b20; }
        .node-badge.sev-info     { background: #1a365d; border-left: 4px solid #4299e1; }
        .node-badge.sev-none     { background: #1c3b2c; border-left: 4px solid #38a169; }
        .node-name { color: #e2e8f0; font-weight: 700; font-size: 15px; flex-shrink: 0; }
        .node-detail { color: rgba(255,255,255,0.60); font-size: 13px; word-break: break-word; }
    </style>
</head>
<body>
    <div class="verdict" style="background:${verdictBg}">${verdictText}</div>
    <div class="meta">
        <span class="meta-text">${escapeHtml(statusText)} &nbsp;|&nbsp; Cluster: ${escapeHtml(clusterText)}</span>
        <span id="cost-display"></span>
        <button class="btn-cost" id="btn-cost" onclick="getCost()">💰 Get Cost</button>
        ${hasSource ? `<button class="btn-source" onclick="vscode.postMessage({type:'showSource'})">📄 View Source</button>` : ''}
    </div>
    <div class="dag-section">
        <h3>Execution Plan</h3>
        ${planTreeHtml}
    </div>
    ${planIssues.length > 0 ? `<div class="cards-section">
        <h3>Suggestions (${planIssues.length})</h3>
        ${cardsSvg}
    </div>` : ''}
    ${rawPlans.length > 0 ? `<div class="raw-section">
        <details>
            <summary class="raw-summary">Raw Execution Plans (${rawPlans.length})</summary>
            <div class="raw-plans">${rawPlans.map((p, i) =>
                `<div class="raw-plan">
                    <div class="raw-plan-label">${escapeHtml(p.description || `Query ${i + 1}`)}</div>
                    <pre class="raw-plan-text">${escapeHtml(p.physicalPlan)}</pre>
                </div>`
            ).join('\n')}</div>
        </details>
    </div>` : ''}
    <script>
        const vscode = acquireVsCodeApi();
        function getCost() {
            const btn = document.getElementById('btn-cost');
            const display = document.getElementById('cost-display');
            btn.disabled = true;
            btn.textContent = '⏳ Fetching…';
            display.textContent = '';
            display.style.color = '#a0aec0';
            vscode.postMessage({ type: 'getCost' });
        }
        window.addEventListener('message', event => {
            const msg = event.data;
            const btn = document.getElementById('btn-cost');
            const display = document.getElementById('cost-display');
            if (msg.type === 'costResult') {
                btn.style.display = 'none';
                if (msg.error) {
                    display.style.color = '#fc8181';
                    display.textContent = '⚠ ' + msg.error;
                } else {
                    display.style.color = '#68d391';
                    const prefix = msg.approximate ? '~' : '';
                    const note = msg.approximate ? ' (job total for this day)' : '';
                    display.textContent = prefix + '$' + msg.dollars.toFixed(2) + ' (' + msg.dbus.toFixed(2) + ' DBUs)' + note;
                }
            } else if (msg.type === 'costCancelled') {
                btn.disabled = false;
                btn.textContent = '💰 Get Cost';
            }
        });
    </script>
</body>
</html>`;
}

// ── Layout ──────────────────────────────────────────────────────────────────

const NODE_W = 160;
const NODE_H = 58;
const H_GAP = 20;
const V_GAP = 60;
const SVG_W = 900;       // minimum/default width; may expand for wide plans
const SVG_MAIN_H = 520;
const SVG_PADDING = 30; // horizontal padding on each side

/** Compute the SVG width needed to fit all nodes without clipping. */
function computeSvgWidth(roots: PlanNode[]): number {
    const all = collectAll(roots);
    const depths = assignDepths(roots);
    const byDepth = new Map<number, number>();
    for (const node of all) {
        const d = depths.get(node.id) ?? 0;
        byDepth.set(d, (byDepth.get(d) ?? 0) + 1);
    }
    let maxRowWidth = 0;
    for (const count of byDepth.values()) {
        maxRowWidth = Math.max(maxRowWidth, count * NODE_W + (count - 1) * H_GAP);
    }
    return Math.max(SVG_W, maxRowWidth + SVG_PADDING * 2);
}

interface LayoutNode {
    node: PlanNode;
    x: number;
    y: number;
}

function collectAll(roots: PlanNode[]): PlanNode[] {
    const all: PlanNode[] = [];
    function walk(n: PlanNode): void {
        all.push(n);
        n.children.forEach(walk);
    }
    roots.forEach(walk);
    return all;
}

function assignDepths(roots: PlanNode[]): Map<string, number> {
    const depths = new Map<string, number>();
    function walk(n: PlanNode, d: number): void {
        const existing = depths.get(n.id);
        if (existing !== undefined && existing <= d) { return; }
        depths.set(n.id, d);
        n.children.forEach(c => walk(c, d + 1));
    }
    roots.forEach(n => walk(n, 0));
    return depths;
}

function layoutNodes(roots: PlanNode[], svgW: number = SVG_W): LayoutNode[] {
    const all = collectAll(roots);
    const depths = assignDepths(roots);

    const byDepth = new Map<number, PlanNode[]>();
    for (const node of all) {
        const d = depths.get(node.id) ?? 0;
        if (!byDepth.has(d)) { byDepth.set(d, []); }
        byDepth.get(d)!.push(node);
    }

    const maxDepth = byDepth.size > 0 ? Math.max(...byDepth.keys()) : 0;
    const totalH = (maxDepth + 1) * (NODE_H + V_GAP);
    const scale = Math.min(1, SVG_MAIN_H / Math.max(totalH, 1));

    const layout: LayoutNode[] = [];
    for (const [depth, nodesAtDepth] of byDepth) {
        const count = nodesAtDepth.length;
        const totalW = count * NODE_W + (count - 1) * H_GAP;
        const startX = (svgW - totalW) / 2;
        nodesAtDepth.forEach((node, i) => {
            layout.push({
                node,
                x: startX + i * (NODE_W + H_GAP),
                y: depth * (NODE_H + V_GAP) * scale + 20,
            });
        });
    }

    return layout;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function severityFill(severity: string): string {
    switch (severity) {
        case 'critical': return '#e53e3e';
        case 'warning': return '#dd6b20';
        case 'info': return '#4299e1';
        case 'none': return '#38a169';
        default: return '#718096';
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function generateHtml(roots: PlanNode[]): string {
    if (roots.length === 0) {
        return `<!DOCTYPE html><html><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:40px">
            <p>No plan data available. Run a dry-run analysis first (Ctrl+Shift+K).</p>
        </body></html>`;
    }

    const layout = layoutNodes(roots);
    const posMap = new Map<string, LayoutNode>(layout.map(l => [l.node.id, l]));
    const allNodes = collectAll(roots);

    // Edges
    const edgesSvg: string[] = [];
    for (const node of allNodes) {
        const from = posMap.get(node.id);
        if (!from) { continue; }
        for (const child of node.children) {
            const to = posMap.get(child.id);
            if (!to) { continue; }
            const x1 = from.x + NODE_W / 2;
            const y1 = from.y + NODE_H;
            const x2 = to.x + NODE_W / 2;
            const y2 = to.y;
            const cy = (y1 + y2) / 2;
            edgesSvg.push(
                `<path d="M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}" ` +
                `stroke="#718096" stroke-width="1.5" fill="none"/>`,
            );
        }
    }

    // Nodes
    const nodesSvg: string[] = layout.map(({ node, x, y }) => {
        const fill = severityFill(node.severity);
        const label = node.operatorName.length > 22
            ? node.operatorName.substring(0, 20) + '\u2026'
            : node.operatorName;
        const srcLine = node.sourceLine !== undefined ? node.sourceLine : -1;
        const glowFilter = node.severity === 'critical'
            ? 'filter="url(#glow-red)"'
            : node.severity === 'warning' ? 'filter="url(#glow-orange)"' : '';

        const detailLines = node.details ? node.details.split('\n').slice(0, 2) : [];
        const detailsSvg = detailLines.map((dl, i) =>
            `<text x="${x + NODE_W / 2}" y="${y + 30 + i * 13}" text-anchor="middle"
                  fill="rgba(255,255,255,0.70)" font-size="9"
                  font-family="ui-monospace,monospace">${escapeHtml(dl)}</text>`,
        ).join('');

        return `<g class="dag-node" onclick="nodeClick(${srcLine}, '${escapeHtml(node.operatorName)}')">
            <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="6"
                  fill="${fill}" ${glowFilter} opacity="0.92"/>
            <text x="${x + NODE_W / 2}" y="${y + 17}" text-anchor="middle"
                  fill="white" font-size="11" font-weight="bold"
                  font-family="ui-monospace,monospace">${escapeHtml(label)}</text>
            ${detailsSvg}
        </g>`;
    });

    // Legend
    const legendItems = [
        { color: '#e53e3e', label: 'Critical (Sort-Merge Join, Cartesian Product, Nested Join)' },
        { color: '#dd6b20', label: 'Warning (Shuffle / Exchange, Aggregate / SortAggregate)' },
        { color: '#4299e1', label: 'Info (Hash Join)' },
        { color: '#38a169', label: 'OK (Read / FileScan, Filter, Select)' },
    ];
    const legendSvg = legendItems.map((item, i) =>
        `<g transform="translate(10,${i * 22})">
            <rect width="14" height="14" rx="3" fill="${item.color}"/>
            <text x="22" y="11" font-size="11" fill="#a0a0a0"
                  font-family="-apple-system,sans-serif">${escapeHtml(item.label)}</text>
        </g>`,
    ).join('\n');
    const legendH = legendItems.length * 22 + 16;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CatalystOps: Plan DAG</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #1e1e1e; overflow: auto; }
        .dag-node { cursor: pointer; }
        .dag-node:hover rect { brightness: 1.15; }
        .dag-node rect { transition: opacity 0.1s; }
        .dag-node:hover rect { opacity: 1 !important; }
    </style>
</head>
<body>
    <svg width="${SVG_W}" height="${SVG_MAIN_H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <filter id="glow-red" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur"/>
                <feFlood flood-color="#e53e3e" flood-opacity="0.6" result="color"/>
                <feComposite in="color" in2="blur" operator="in" result="glow"/>
                <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="glow-orange" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur"/>
                <feFlood flood-color="#dd6b20" flood-opacity="0.5" result="color"/>
                <feComposite in="color" in2="blur" operator="in" result="glow"/>
                <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
        </defs>
        ${edgesSvg.join('\n        ')}
        ${nodesSvg.join('\n        ')}
    </svg>
    <svg width="${SVG_W}" height="${legendH}" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(20, 8)">${legendSvg}</g>
    </svg>
    <script>
        const vscodeApi = acquireVsCodeApi();
        function nodeClick(sourceLine, operator) {
            if (sourceLine >= 0) {
                vscodeApi.postMessage({ type: 'nodeClick', sourceLine: sourceLine, operator: operator });
            }
        }
    </script>
</body>
</html>`;
}
