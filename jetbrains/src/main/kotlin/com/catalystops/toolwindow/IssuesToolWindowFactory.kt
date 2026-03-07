package com.catalystops.toolwindow

import com.catalystops.telemetry.TelemetryService
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class IssuesToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        TelemetryService.track("toolwindow.opened")
        val panel = IssuesPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "Issues", false)
        toolWindow.contentManager.addContent(content)
    }
}
