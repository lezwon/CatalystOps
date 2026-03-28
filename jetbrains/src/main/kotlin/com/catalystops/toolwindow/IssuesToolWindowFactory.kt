package com.catalystops.toolwindow

import com.catalystops.telemetry.TelemetryService
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class IssuesToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        TelemetryService.track("toolwindow.opened")

        val issuesPanel = IssuesPanel(project)
        val issuesContent = ContentFactory.getInstance().createContent(issuesPanel, "Issues", false)
        toolWindow.contentManager.addContent(issuesContent)

        val jobsPanel = JobsPanel(project, issuesPanel)
        val jobsContent = ContentFactory.getInstance().createContent(jobsPanel, "Jobs", false)
        toolWindow.contentManager.addContent(jobsContent)
    }
}
