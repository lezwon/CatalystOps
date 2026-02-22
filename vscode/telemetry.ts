import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';

const INSTRUMENTATION_CONNECTION_STRING = 'InstrumentationKey=c2a13996-87aa-4c32-8ed1-efb11c5a18e2;IngestionEndpoint=https://westus3-1.in.applicationinsights.azure.com/;LiveEndpoint=https://westus3.livediagnostics.monitor.azure.com/;ApplicationId=f4fedf89-8fdb-4fee-b968-dc56272aa051';

let reporter: TelemetryReporter | undefined;

export function initTelemetry(context: vscode.ExtensionContext): void {
    reporter = new TelemetryReporter(INSTRUMENTATION_CONNECTION_STRING);
    context.subscriptions.push(reporter);  // auto-disposed on deactivate
}

export function sendEvent(
    eventName: string,
    properties?: Record<string, string>,
): void {
    reporter?.sendTelemetryEvent(eventName, properties);
}
