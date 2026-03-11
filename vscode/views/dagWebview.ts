/**
 * Plan DAG WebviewPanel - Visual SVG graph of the physical plan.
 * Nodes are colored by severity; clicking a node reveals the source line.
 */

import * as vscode from 'vscode';
import { PlanNode } from '../analysis/planTreeBuilder';
import { sendEvent } from '../telemetry';

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

// ── Layout ──────────────────────────────────────────────────────────────────

const NODE_W = 130;
const NODE_H = 44;
const H_GAP = 20;
const V_GAP = 60;
const SVG_W = 900;
const SVG_MAIN_H = 520;

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

function layoutNodes(roots: PlanNode[]): LayoutNode[] {
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
        const startX = (SVG_W - totalW) / 2;
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
        const label = node.operatorName.length > 20
            ? node.operatorName.substring(0, 18) + '\u2026'
            : node.operatorName;
        const subLabel = node.issue ? `${node.issue.costPoints} pts` : '';
        const srcLine = node.sourceLine !== undefined ? node.sourceLine : -1;
        const glowFilter = node.severity === 'critical'
            ? 'filter="url(#glow-red)"'
            : node.severity === 'warning' ? 'filter="url(#glow-orange)"' : '';

        return `<g class="dag-node" onclick="nodeClick(${srcLine}, '${escapeHtml(node.operatorName)}')">
            <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="6"
                  fill="${fill}" ${glowFilter} opacity="0.92"/>
            <text x="${x + NODE_W / 2}" y="${y + 16}" text-anchor="middle"
                  fill="white" font-size="11" font-weight="bold"
                  font-family="ui-monospace,monospace">${escapeHtml(label)}</text>
            <text x="${x + NODE_W / 2}" y="${y + 32}" text-anchor="middle"
                  fill="rgba(255,255,255,0.75)" font-size="10"
                  font-family="ui-monospace,monospace">${escapeHtml(subLabel)}</text>
        </g>`;
    });

    // Legend
    const legendItems = [
        { color: '#e53e3e', label: 'Critical (SortMergeJoin, CartesianProduct)' },
        { color: '#dd6b20', label: 'Warning (Exchange, SortAggregate)' },
        { color: '#4299e1', label: 'Info (BroadcastHashJoin)' },
        { color: '#38a169', label: 'OK (FileScan, Filter, Project)' },
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
