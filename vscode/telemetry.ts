import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';

const INSTRUMENTATION_CONNECTION_STRING = 'InstrumentationKey=c2a13996-87aa-4c32-8ed1-efb11c5a18e2;IngestionEndpoint=https://westus3-1.in.applicationinsights.azure.com/;LiveEndpoint=https://westus3.livediagnostics.monitor.azure.com/;ApplicationId=f4fedf89-8fdb-4fee-b968-dc56272aa051';

const FEEDBACK_FORM_URL = 'https://tinyurl.com/catalystopssurvey';

const FEEDBACK_SHOWN_KEY = 'catalystops.feedbackShown';

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
