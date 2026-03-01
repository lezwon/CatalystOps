/**
 * Local file cache for billing rows with 1-hour TTL.
 * Files stored at {globalStorageUri}/billing/{startDate}_{endDate}.json
 */

import * as vscode from 'vscode';
import { BillingRow } from './billingTypes';

const TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
    timestamp: number;
    rows: BillingRow[];
}

function cacheUri(context: vscode.ExtensionContext, key: string): vscode.Uri {
    // Sanitise the key so it's a valid filename
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return vscode.Uri.joinPath(context.globalStorageUri, 'billing', `${safe}.json`);
}

export function cacheKey(startDate: string, endDate: string): string {
    return `${startDate}_${endDate}`;
}

export async function loadFromCache(
    context: vscode.ExtensionContext,
    key: string,
): Promise<BillingRow[] | null> {
    try {
        const uri = cacheUri(context, key);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const entry = JSON.parse(Buffer.from(bytes).toString('utf-8')) as CacheEntry;
        if (Date.now() - entry.timestamp > TTL_MS) {
            return null;
        }
        return entry.rows;
    } catch {
        return null;
    }
}

export async function saveToCache(
    context: vscode.ExtensionContext,
    key: string,
    rows: BillingRow[],
): Promise<void> {
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'billing');
    try {
        await vscode.workspace.fs.createDirectory(dir);
    } catch {
        // Directory may already exist
    }
    const entry: CacheEntry = { timestamp: Date.now(), rows };
    const bytes = Buffer.from(JSON.stringify(entry), 'utf-8');
    await vscode.workspace.fs.writeFile(cacheUri(context, key), bytes);
}

export async function clearCache(
    context: vscode.ExtensionContext,
    key?: string,
): Promise<void> {
    if (key) {
        try { await vscode.workspace.fs.delete(cacheUri(context, key)); } catch { /* ok */ }
        return;
    }
    // Delete all cache files in the billing directory
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'billing');
    try {
        await vscode.workspace.fs.delete(dir, { recursive: true });
    } catch { /* ok */ }
}
