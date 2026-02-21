/**
 * CatalystOps Output Channel Logger
 * Provides a named output channel in the VS Code Output tab.
 */

import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

export function initOutputChannel(context: vscode.ExtensionContext): void {
    _channel = vscode.window.createOutputChannel('CatalystOps');
    context.subscriptions.push(_channel);
}

export function log(message: string): void {
    const ts = new Date().toISOString().substring(11, 23);
    _channel?.appendLine(`[${ts}] ${message}`);
}

export function logError(message: string): void {
    log(`ERROR: ${message}`);
}

export function logDebug(message: string): void {
    const debugEnabled = vscode.workspace
        .getConfiguration('catalystops')
        .get<boolean>('debug', false);
    if (debugEnabled) {
        log(`[debug] ${message}`);
    }
}

export function showOutput(): void {
    _channel?.show(true);
}
