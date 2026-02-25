import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';
import { computeNudgeState } from './nudgeState';

const INSTRUMENTATION_CONNECTION_STRING = 'InstrumentationKey=c2a13996-87aa-4c32-8ed1-efb11c5a18e2;IngestionEndpoint=https://westus3-1.in.applicationinsights.azure.com/;LiveEndpoint=https://westus3.livediagnostics.monitor.azure.com/;ApplicationId=f4fedf89-8fdb-4fee-b968-dc56272aa051';

const FEEDBACK_FORM_URL = 'https://tinyurl.com/catalystopssurvey';

const FEEDBACK_SHOWN_KEY = 'catalystops.feedbackShown';
const DRY_RUN_NUDGE_SHOWN_KEY = 'catalystops.dryRunNudgeShown';
const DRY_RUN_NUDGE_SCAN_COUNT_KEY = 'catalystops.dryRunNudgeScanCount';
export const HAS_USED_DRY_RUN_KEY = 'catalystops.hasUsedDryRun';

const DRY_RUN_NUDGE_SCAN_THRESHOLD = 3;

let reporter: TelemetryReporter | undefined;
let _context: vscode.ExtensionContext | undefined;
let _feedbackTimerSet = false;

export function initTelemetry(context: vscode.ExtensionContext): void {
    reporter = new TelemetryReporter(INSTRUMENTATION_CONNECTION_STRING);
    _context = context;
    context.subscriptions.push(reporter);  // auto-disposed on deactivate
}

export function sendEvent(
    eventName: string,
    properties?: Record<string, string>,
): void {
    reporter?.sendTelemetryEvent(eventName, properties);
}

/**
 * Nudge users who haven't tried the dry-run feature yet.
 *
 * Increments a persistent scan counter each time local analysis finds issues.
 * Shows the toast once after DRY_RUN_NUDGE_SCAN_THRESHOLD scans with issues,
 * so new users get time to explore local analysis before being prompted.
 * Skipped entirely if the user has already run a dry run.
 */
export async function maybeShowDryRunNudge(issueCount: number): Promise<void> {
    if (!_context) { return; }

    const { shouldShow, newScanCount } = computeNudgeState({
        issueCount,
        nudgeShown: _context.globalState.get<boolean>(DRY_RUN_NUDGE_SHOWN_KEY) ?? false,
        hasUsedDryRun: _context.globalState.get<boolean>(HAS_USED_DRY_RUN_KEY) ?? false,
        currentScanCount: _context.globalState.get<number>(DRY_RUN_NUDGE_SCAN_COUNT_KEY) ?? 0,
        threshold: DRY_RUN_NUDGE_SCAN_THRESHOLD,
    });

    await _context.globalState.update(DRY_RUN_NUDGE_SCAN_COUNT_KEY, newScanCount);
    if (!shouldShow) { return; }

    await _context.globalState.update(DRY_RUN_NUDGE_SHOWN_KEY, true);
    setTimeout(async () => {
        if (!_context) { return; }
        if (_context.globalState.get<boolean>(HAS_USED_DRY_RUN_KEY)) { return; }
        const label = `CatalystOps found ${issueCount} issue${issueCount !== 1 ? 's' : ''}. Try a deep Catalyst plan analysis on Databricks to catch shuffle, join, and scan issues that only appear at runtime.`;
        const choice = await vscode.window.showInformationMessage(label, 'Try Dry Run (⌘⇧K)', 'Not now');
        if (choice === 'Try Dry Run (⌘⇧K)') {
            sendEvent('dryrun_nudge/clicked');
            vscode.commands.executeCommand('catalystops.analyzeCost');
        }
    }, 2000);
}

/**
 * Schedule a feedback toast 5 seconds after the first file is analyzed.
 * Only fires once per install (persisted via globalState).
 */
export function maybeShowFeedbackToast(): void {
    if (!_context) { return; }
    if (_feedbackTimerSet) { return; }
    if (_context.globalState.get<boolean>(FEEDBACK_SHOWN_KEY)) { return; }

    _feedbackTimerSet = true;
    setTimeout(async () => {
        if (!_context) { return; }
        await _context.globalState.update(FEEDBACK_SHOWN_KEY, true);
        const choice = await vscode.window.showInformationMessage(
            'How is CatalystOps working for you? Share feedback to help us improve.',
            'Give Feedback',
            'Not now',
        );
        if (choice === 'Give Feedback') {
            sendEvent('feedback/form_opened');
            vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_FORM_URL));
        }
    }, 5000);
}
