import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';
import { computeNudgeState } from './nudgeState';

let _appName: string | undefined;

const INSTRUMENTATION_CONNECTION_STRING = 'InstrumentationKey=c2a13996-87aa-4c32-8ed1-efb11c5a18e2;IngestionEndpoint=https://westus3-1.in.applicationinsights.azure.com/;LiveEndpoint=https://westus3.livediagnostics.monitor.azure.com/;ApplicationId=f4fedf89-8fdb-4fee-b968-dc56272aa051';

const FEEDBACK_FORM_URL = 'https://tinyurl.com/catalystopssurvey';

const FEEDBACK_SHOWN_KEY = 'catalystops.feedbackShown';
const LOCAL_ANALYSIS_COUNT_KEY = 'catalystops.localAnalysisCount';
const FEEDBACK_ANALYSIS_THRESHOLD = 100;
const DRY_RUN_NUDGE_SHOWN_KEY = 'catalystops.dryRunNudgeShown';
const DRY_RUN_NUDGE_SCAN_COUNT_KEY = 'catalystops.dryRunNudgeScanCount';
export const HAS_USED_DRY_RUN_KEY = 'catalystops.hasUsedDryRun';

const DRY_RUN_NUDGE_SCAN_THRESHOLD = 3;

// Rating prompt keys
const RATING_DISMISSED_KEY       = 'catalystops.rating.dismissed';
const RATING_ACTION_TAKEN_KEY    = 'catalystops.rating.actionTaken';
const RATING_SHOW_COUNT_KEY      = 'catalystops.rating.showCount';
const RATING_SESSION_COUNT_KEY   = 'catalystops.rating.sessionCount';
const RATING_BILLING_FETCH_KEY   = 'catalystops.rating.billingFetchCount';

const RATING_SESSION_THRESHOLD  = 5;
const RATING_BILLING_THRESHOLD  = 2;
const RATING_MAX_SHOWS          = 2;

const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=CatalystOps.catalystops&ssr=false#review-details';

let reporter: TelemetryReporter | undefined;
let _context: vscode.ExtensionContext | undefined;

export function initTelemetry(context: vscode.ExtensionContext): void {
    reporter = new TelemetryReporter(INSTRUMENTATION_CONNECTION_STRING);
    _context = context;
    _appName = vscode.env.appName;
    context.subscriptions.push(reporter);  // auto-disposed on deactivate
}

export function sendEvent(
    eventName: string,
    properties?: Record<string, string>,
): void {
    reporter?.sendTelemetryEvent(eventName, { appName: _appName ?? '', ...properties });
}

// ── Walkthrough funnel tracking ────────────────────────────────────────────

const WALKTHROUGH_STARTED_KEY      = 'catalystops.walkthrough.started';
const WALKTHROUGH_STEPS_KEY        = 'catalystops.walkthrough.completedSteps';

/**
 * Fire once on first-ever activation to mark the top of the walkthrough funnel.
 * Subsequent activations are no-ops so we measure unique users, not sessions.
 */
export function trackWalkthroughStart(): void {
    if (!_context) { return; }
    if (_context.globalState.get<boolean>(WALKTHROUGH_STARTED_KEY)) { return; }
    void _context.globalState.update(WALKTHROUGH_STARTED_KEY, true);
    sendEvent('walkthrough/started');
}

/**
 * Fire once per step per install. Used to build a completion funnel across
 * walkthrough steps (local-analysis → connect → dry-run → explain-plan →
 * billing → jobs).
 */
export function trackWalkthroughStep(step: string): void {
    if (!_context) { return; }
    const completed = _context.globalState.get<string[]>(WALKTHROUGH_STEPS_KEY) ?? [];
    if (completed.includes(step)) { return; }
    void _context.globalState.update(WALKTHROUGH_STEPS_KEY, [...completed, step]);
    sendEvent('walkthrough/step_completed', { step });
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
        sendEvent('dryrun_nudge/shown', { issueCount: String(issueCount) });
        const choice = await vscode.window.showInformationMessage(label, 'Try Dry Run (⌘⇧K)', 'Not now');
        if (choice === 'Try Dry Run (⌘⇧K)') {
            sendEvent('dryrun_nudge/clicked');
            vscode.commands.executeCommand('catalystops.analyzeCost');
        } else {
            // undefined = toast closed without clicking; 'Not now' = explicit dismiss
            sendEvent('dryrun_nudge/dismissed', { action: choice === 'Not now' ? 'not_now' : 'closed' });
        }
    }, 2000);
}

/**
 * Increment the session count and maybe show the rating prompt.
 * Call once per activation (i.e., each VS Code session).
 */
export async function incrementSessionCount(): Promise<void> {
    if (!_context) { return; }
    const count = (_context.globalState.get<number>(RATING_SESSION_COUNT_KEY) ?? 0) + 1;
    await _context.globalState.update(RATING_SESSION_COUNT_KEY, count);
    if (count >= RATING_SESSION_THRESHOLD) {
        void maybeShowRatingPrompt('sessions');
    }
}

/**
 * Increment the billing fetch counter and maybe show the rating prompt.
 * Call after each successful billing data fetch.
 */
export async function incrementBillingFetchCount(): Promise<void> {
    if (!_context) { return; }
    const count = (_context.globalState.get<number>(RATING_BILLING_FETCH_KEY) ?? 0) + 1;
    await _context.globalState.update(RATING_BILLING_FETCH_KEY, count);
    if (count >= RATING_BILLING_THRESHOLD) {
        void maybeShowRatingPrompt('billing');
    }
}

/**
 * Show a marketplace rating prompt if conditions are met.
 *
 * Guards:
 * - Never show if user already rated/dismissed permanently
 * - Never show more than RATING_MAX_SHOWS times total
 * - Only show when triggered by a meaningful action (dry_run | sessions | billing)
 */
export async function maybeShowRatingPrompt(trigger: string): Promise<void> {
    if (!_context) { return; }

    if (_context.globalState.get<boolean>(RATING_DISMISSED_KEY)) { return; }
    if (_context.globalState.get<boolean>(RATING_ACTION_TAKEN_KEY)) { return; }

    const showCount = _context.globalState.get<number>(RATING_SHOW_COUNT_KEY) ?? 0;
    if (showCount >= RATING_MAX_SHOWS) { return; }

    await _context.globalState.update(RATING_SHOW_COUNT_KEY, showCount + 1);
    sendEvent('rating/shown', { trigger, showCount: String(showCount + 1) });

    const choice = await vscode.window.showInformationMessage(
        'Enjoying CatalystOps? A review on the Marketplace helps other Spark developers find it.',
        'Rate ★★★★★',
        'Maybe later',
        'Don\'t ask again',
    );

    if (choice === 'Rate ★★★★★') {
        await _context.globalState.update(RATING_ACTION_TAKEN_KEY, true);
        sendEvent('rating/clicked', { trigger });
        vscode.env.openExternal(vscode.Uri.parse(MARKETPLACE_URL));
    } else if (choice === 'Don\'t ask again') {
        await _context.globalState.update(RATING_DISMISSED_KEY, true);
        sendEvent('rating/dismissed', { trigger, action: 'permanent' });
    } else {
        // undefined (toast closed) or 'Maybe later'
        sendEvent('rating/dismissed', { trigger, action: choice === 'Maybe later' ? 'later' : 'closed' });
    }
}

/**
 * Increment the local analysis counter and show a feedback toast once the
 * user has completed FEEDBACK_ANALYSIS_THRESHOLD successful local analyses.
 * Only fires once per install (persisted via globalState).
 */
export async function maybeShowFeedbackToast(): Promise<void> {
    if (!_context) { return; }
    if (_context.globalState.get<boolean>(FEEDBACK_SHOWN_KEY)) { return; }

    const count = (_context.globalState.get<number>(LOCAL_ANALYSIS_COUNT_KEY) ?? 0) + 1;
    await _context.globalState.update(LOCAL_ANALYSIS_COUNT_KEY, count);
    if (count < FEEDBACK_ANALYSIS_THRESHOLD) { return; }

    // Mark shown immediately so concurrent calls don't double-fire
    await _context.globalState.update(FEEDBACK_SHOWN_KEY, true);

    setTimeout(async () => {
        if (!_context) { return; }
        sendEvent('feedback/shown', { analysisCount: String(count) });
        const choice = await vscode.window.showInformationMessage(
            'How is CatalystOps working for you? Share feedback to help us improve.',
            'Give Feedback',
            'Not now',
        );
        if (choice === 'Give Feedback') {
            sendEvent('feedback/form_opened');
            vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_FORM_URL));
        } else {
            sendEvent('feedback/dismissed', { action: choice === 'Not now' ? 'not_now' : 'closed' });
        }
    }, 5000);
}
