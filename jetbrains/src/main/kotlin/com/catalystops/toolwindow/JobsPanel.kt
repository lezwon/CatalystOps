package com.catalystops.toolwindow

import com.catalystops.analysis.PlanIssue
import com.catalystops.analysis.PlanParser
import com.catalystops.databricks.DatabricksClient
import com.catalystops.databricks.EventLogFetcher
import com.catalystops.databricks.JobSummary
import com.catalystops.databricks.RunSummary
import com.catalystops.settings.DatabricksSettings
import com.catalystops.telemetry.TelemetryService
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.SwingConstants

data class JobWithRun(val job: JobSummary, val lastRun: RunSummary? = null)

class JobsPanel(private val project: Project, private val issuesPanel: IssuesPanel) : JBPanel<JobsPanel>(BorderLayout()) {

    private val model = DefaultListModel<JobWithRun>()
    private val list = JBList(model).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = JobCellRenderer()
    }
    private val statusLabel = JBLabel("Double-click a job to analyze its last run.", SwingConstants.CENTER)
    private val refreshButton = JButton("Refresh Jobs")

    init {
        border = JBUI.Borders.empty(4)

        val topPanel = JPanel(BorderLayout()).apply {
            add(refreshButton, BorderLayout.WEST)
            add(statusLabel, BorderLayout.CENTER)
        }

        add(topPanel, BorderLayout.NORTH)
        add(JBScrollPane(list), BorderLayout.CENTER)

        refreshButton.addActionListener { refreshJobs() }

        list.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) {
                    val selected = list.selectedValue ?: return
                    analyzeJobRun(selected)
                }
            }
        })
    }

    private fun refreshJobs() {
        val settings = DatabricksSettings.getInstance(project).state
        if (settings.host.isEmpty() || settings.token.isEmpty()) {
            statusLabel.text = "Configure Databricks connection first."
            return
        }

        statusLabel.text = "Loading jobs…"
        refreshButton.isEnabled = false
        TelemetryService.track("jobs/refresh_start")

        object : Task.Backgroundable(project, "CatalystOps: Loading jobs…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = buildClient(settings)
                    val jobs = client.listJobs()

                    // Fetch last run for each job in parallel (best-effort, sequential for simplicity)
                    val jobsWithRuns = jobs.map { job ->
                        try {
                            val lastRun = client.getLastRun(job.jobId)
                            JobWithRun(job, lastRun)
                        } catch (_: Exception) {
                            JobWithRun(job)
                        }
                    }

                    ApplicationManager.getApplication().invokeLater {
                        model.clear()
                        jobsWithRuns.forEach { model.addElement(it) }
                        statusLabel.text = "${jobs.size} job(s). Double-click to analyze."
                        refreshButton.isEnabled = true
                        TelemetryService.track("jobs/refresh_complete", mapOf("count" to jobs.size.toString()))
                    }
                } catch (ex: Exception) {
                    val msg = ex.message ?: ex.javaClass.simpleName
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "Error: ${msg.take(100)}"
                        refreshButton.isEnabled = true
                        TelemetryService.track("jobs/refresh_failed", mapOf("error" to msg.take(200)))
                    }
                }
            }
        }.queue()
    }

    private fun analyzeJobRun(jobWithRun: JobWithRun) {
        val settings = DatabricksSettings.getInstance(project).state
        if (settings.host.isEmpty() || settings.token.isEmpty()) {
            statusLabel.text = "Configure Databricks connection first."
            return
        }

        val lastRun = jobWithRun.lastRun
        if (lastRun == null) {
            statusLabel.text = "No runs found for job \"${jobWithRun.job.name}\"."
            return
        }

        statusLabel.text = "Analyzing \"${jobWithRun.job.name}\"…"

        object : Task.Backgroundable(project, "CatalystOps: Analyzing job run…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = buildClient(settings)

                    indicator.text = "Fetching run details…"
                    indicator.fraction = 0.1

                    val clusterId = lastRun.clusterId
                    if (clusterId == null) {
                        ApplicationManager.getApplication().invokeLater {
                            statusLabel.text = "Job ran on serverless — event logs not available for plan analysis."
                        }
                        return
                    }

                    indicator.text = "Resolving event log path…"
                    indicator.fraction = 0.2
                    val logPath = client.getClusterEventLogPath(clusterId)
                        ?: "dbfs:/cluster-logs/$clusterId/eventlog"

                    indicator.text = "Reading event log…"
                    indicator.fraction = 0.4
                    val planEntries = EventLogFetcher.fetchPlans(client, logPath)

                    if (planEntries.isEmpty()) {
                        ApplicationManager.getApplication().invokeLater {
                            statusLabel.text = "No SQL plans found in event log for \"${jobWithRun.job.name}\"."
                        }
                        TelemetryService.track("job_run/analyzed", mapOf(
                            "jobName" to jobWithRun.job.name,
                            "planCount" to "0",
                            "issueCount" to "0"
                        ))
                        return
                    }

                    indicator.text = "Analyzing plans…"
                    indicator.fraction = 0.7

                    val allIssues = mutableListOf<PlanIssue>()
                    for (entry in planEntries) {
                        allIssues.addAll(PlanParser.parsePlan(entry.physicalPlan))
                    }

                    // Deduplicate by name + tableName
                    val seen = mutableSetOf<String>()
                    val deduped = allIssues.filter { seen.add("${it.name}:${it.tableName ?: ""}") }

                    indicator.text = "Done"
                    indicator.fraction = 1.0

                    TelemetryService.track("job_run/analyzed", mapOf(
                        "jobName" to jobWithRun.job.name,
                        "planCount" to planEntries.size.toString(),
                        "issueCount" to deduped.size.toString()
                    ))

                    ApplicationManager.getApplication().invokeLater {
                        issuesPanel.updatePlanIssues(deduped)
                        statusLabel.text = "\"${jobWithRun.job.name}\": ${deduped.size} plan issue(s)."
                    }
                } catch (ex: Exception) {
                    val msg = ex.message ?: ex.javaClass.simpleName
                    TelemetryService.track("job_run/failed", mapOf("jobName" to jobWithRun.job.name, "error" to msg.take(200)))
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "Error: ${msg.take(100)}"
                    }
                }
            }
        }.queue()
    }

    private fun buildClient(settings: DatabricksSettings.State): DatabricksClient {
        val host = normalizeHost(settings.host)
        return DatabricksClient(host, settings.token)
    }

    private fun normalizeHost(host: String): String {
        val h = host.trimEnd('/')
        return if (h.startsWith("https://") || h.startsWith("http://")) h else "https://$h"
    }
}
