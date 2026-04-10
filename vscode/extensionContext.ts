/**
 * Global extension context accessor.
 * Allows modules outside of activate() to access SecretStorage and other context APIs.
 */

import * as vscode from 'vscode';

let _ctx: vscode.ExtensionContext | undefined;

export function setExtensionContext(ctx: vscode.ExtensionContext): void {
    _ctx = ctx;
}

export function getSecrets(): vscode.SecretStorage {
    if (!_ctx) { throw new Error('Extension context not initialized'); }
    return _ctx.secrets;
}
