package com.catalystops.telemetry

import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Fires once per IDE session (first project opened).
 * Initialises TelemetryService and sends a "plugin.activated" event.
 *
 * Replace CONNECTION_STRING with your App Insights connection string, e.g.:
 *   InstrumentationKey=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/
 */
class PluginStartupActivity : ProjectActivity {

    companion object {
        private const val CONNECTION_STRING =
            "InstrumentationKey=c2a13996-87aa-4c32-8ed1-efb11c5a18e2;" +
            "IngestionEndpoint=https://westus3-1.in.applicationinsights.azure.com/;" +
            "LiveEndpoint=https://westus3.livediagnostics.monitor.azure.com/;" +
            "ApplicationId=f4fedf89-8fdb-4fee-b968-dc56272aa051"
    }

    override suspend fun execute(project: Project) {
        TelemetryService.init(CONNECTION_STRING)
        TelemetryService.track(
            "plugin.activated",
            mapOf(
                "ideVersion" to ApplicationInfo.getInstance().fullVersion,
                "ideBuild"   to ApplicationInfo.getInstance().build.asString(),
            )
        )
    }
}
