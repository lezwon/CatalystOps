package com.catalystops.actions

import com.catalystops.analysis.PlanIssue
import com.catalystops.analysis.PlanParser
import com.catalystops.databricks.DatabricksClient
import com.catalystops.databricks.ScriptNeutralizer
import com.catalystops.settings.DatabricksSettings
import com.catalystops.telemetry.TelemetryService
import com.catalystops.toolwindow.IssuesPanel
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager

class RunDryRunAction : AnAction("CatalystOps: Run Dry Run") {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.PSI_FILE)
        e.presentation.isEnabledAndVisible = file?.language?.id == "Python"
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(CommonDataKeys.PSI_FILE) ?: return
        if (file.language.id != "Python") return

        val settings = DatabricksSettings.getInstance(project).state
        if (settings.host.isEmpty() || settings.token.isEmpty()) {
            showNotification(
                project,
                "CatalystOps: Configure Databricks connection first (Tools → CatalystOps).",
                NotificationType.WARNING
            )
            return
        }

        val code = file.text ?: return
        TelemetryService.track("dry_run/started", mapOf("mode" to settings.executionMode))

        object : Task.Backgroundable(project, "CatalystOps: Running dry run…", true) {
            override fun run(indicator: ProgressIndicator) {
                runDryRun(project, settings, code, indicator)
            }
        }.queue()
    }

    private fun runDryRun(
        project: Project,
        settings: DatabricksSettings.State,
        code: String,
        indicator: ProgressIndicator
    ) {
        try {
            indicator.text = "Neutralizing script…"
            indicator.fraction = 0.1
            val neutralized = ScriptNeutralizer.neutralize(code)

            val client = DatabricksClient(
                normalizeHost(settings.host),
                settings.token
            )

            val output: String

            if (settings.executionMode == "cluster" && settings.clusterId.isNotEmpty()) {
                indicator.text = "Creating execution context…"
                indicator.fraction = 0.2
                val contextId = client.createContext(settings.clusterId)

                indicator.text = "Submitting script to cluster…"
                indicator.fraction = 0.3
                val commandId = client.executeCommand(contextId, settings.clusterId, neutralized)

                // Poll for completion
                val startMs = System.currentTimeMillis()
                val timeoutMs = settings.timeoutSeconds * 1000L
                var result = client.getCommandStatus(contextId, settings.clusterId, commandId)

                while (result.status !in listOf("Finished", "Error", "Cancelled")) {
                    if (indicator.isCanceled) {
                        client.destroyContext(contextId, settings.clusterId)
                        return
                    }
                    val elapsed = System.currentTimeMillis() - startMs
                    if (elapsed > timeoutMs) {
                        client.destroyContext(contextId, settings.clusterId)
                        showNotification(project, "CatalystOps: Dry run timed out after ${settings.timeoutSeconds}s.", NotificationType.ERROR)
                        TelemetryService.track("dry_run/timeout", mapOf("mode" to "cluster"))
                        return
                    }
                    indicator.text = "Running on cluster… ${elapsed / 1000}s"
                    indicator.fraction = 0.3 + (elapsed.toDouble() / timeoutMs) * 0.5
                    Thread.sleep(2000)
                    result = client.getCommandStatus(contextId, settings.clusterId, commandId)
                }

                client.destroyContext(contextId, settings.clusterId)

                if (result.status == "Error") {
                    showNotification(project, "CatalystOps: Dry run failed on cluster: ${result.results?.take(200)}", NotificationType.ERROR)
                    TelemetryService.track("dry_run/failed", mapOf("mode" to "cluster"))
                    return
                }
                output = result.results ?: ""
            } else {
                showNotification(
                    project,
                    "CatalystOps: Serverless dry run requires uploading the script. Configure a cluster ID for interactive execution.",
                    NotificationType.WARNING
                )
                return
            }

            indicator.text = "Parsing plan output…"
            indicator.fraction = 0.9

            // Extract explain() blocks from output
            val planIssues = parsePlanOutput(output)

            indicator.text = "Done"
            indicator.fraction = 1.0

            TelemetryService.track("dry_run/complete", mapOf(
                "mode" to settings.executionMode,
                "issueCount" to planIssues.size.toString()
            ))

            // Update tool window on EDT
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CatalystOps")
                if (toolWindow != null) {
                    val content = toolWindow.contentManager.findContent("Issues")
                    val panel = content?.component as? IssuesPanel
                    panel?.updatePlanIssues(planIssues)
                }
                val msg = if (planIssues.isEmpty()) {
                    "CatalystOps: Dry run complete. No plan issues found."
                } else {
                    "CatalystOps: Dry run complete. ${planIssues.size} plan issue(s) found."
                }
                showNotification(project, msg, NotificationType.INFORMATION)
            }
        } catch (ex: Exception) {
            val msg = ex.message ?: ex.javaClass.simpleName
            TelemetryService.track("dry_run/error", mapOf("error" to msg.take(200)))
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                showNotification(project, "CatalystOps: Dry run error: ${msg.take(300)}", NotificationType.ERROR)
            }
        }
    }

    private fun parsePlanOutput(output: String): List<PlanIssue> {
        if (output.isEmpty()) return emptyList()
        val allIssues = mutableListOf<PlanIssue>()
        // The explain() output may contain multiple plans separated by == Physical Plan ==
        val planBlocks = output.split(Regex("""={2,}\s*Physical Plan\s*={2,}""", RegexOption.IGNORE_CASE))
        for (block in planBlocks) {
            if (block.trim().isEmpty()) continue
            allIssues.addAll(PlanParser.parsePlan(block))
        }
        // Deduplicate by name
        val seen = mutableSetOf<String>()
        return allIssues.filter { seen.add("${it.name}:${it.tableName ?: ""}") }
    }

    private fun normalizeHost(host: String): String {
        val h = host.trimEnd('/')
        return if (h.startsWith("https://") || h.startsWith("http://")) h else "https://$h"
    }

    private fun showNotification(project: Project, message: String, type: NotificationType) {
        try {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("CatalystOps")
                .createNotification(message, type)
                .notify(project)
        } catch (_: Exception) {
            // Notification group may not exist in test environments
        }
    }
}
