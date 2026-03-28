package com.catalystops.toolwindow

import com.catalystops.analysis.PlanIssue
import com.catalystops.inspection.SparkActionInspection
import com.catalystops.inspection.SparkCachingInspection
import com.catalystops.inspection.SparkConfigInspection
import com.catalystops.inspection.SparkDeltaInspection
import com.catalystops.inspection.SparkJoinInspection
import com.catalystops.inspection.SparkLoopInspection
import com.catalystops.inspection.SparkSchemaInspection
import com.catalystops.inspection.SparkSecurityInspection
import com.catalystops.inspection.SparkShuffleInspection
import com.catalystops.inspection.SparkStreamingInspection
import com.catalystops.inspection.SparkUdfInspection
import com.catalystops.inspection.SparkWindowInspection
import com.catalystops.inspection.SparkWriteInspection
import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.InspectionManager
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiManager
import com.intellij.ui.TitledSeparator
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.OpenSourceUtil
import com.intellij.util.ui.JBUI
import com.jetbrains.python.psi.PyFile
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JPanel
import javax.swing.ListSelectionModel

private val INSPECTION_TOOLS: List<LocalInspectionTool> = listOf(
    SparkActionInspection(),
    SparkJoinInspection(),
    SparkUdfInspection(),
    SparkWriteInspection(),
    SparkShuffleInspection(),
    SparkSchemaInspection(),
    SparkStreamingInspection(),
    SparkDeltaInspection(),
    SparkConfigInspection(),
    SparkLoopInspection(),
    SparkWindowInspection(),
    SparkSecurityInspection(),
)

class IssuesPanel(private val project: Project) : JBPanel<IssuesPanel>(BorderLayout()) {

    // ── Code issues (local static analysis) ──────────────────────────────────

    private val codeModel = DefaultListModel<ProblemDescriptor>()
    private val codeList = JBList(codeModel).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = IssueCellRenderer()
    }

    // ── Plan issues (from dry run) ────────────────────────────────────────────

    private val planModel = DefaultListModel<PlanIssue>()
    private val planList = JBList(planModel).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = PlanIssueCellRenderer()
    }

    private val planSection: JPanel

    init {
        border = JBUI.Borders.empty(4)

        // Build plan issues section (initially hidden)
        planSection = JPanel(BorderLayout()).apply {
            isVisible = false
            add(TitledSeparator("Plan Issues (from dry run)"), BorderLayout.NORTH)
            add(JBScrollPane(planList).apply {
                preferredSize = Dimension(0, 160)
            }, BorderLayout.CENTER)
        }

        // Build content panel with both sections
        val contentPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(TitledSeparator("Code Issues"))
            add(JBScrollPane(codeList))
            add(planSection)
        }

        add(contentPanel, BorderLayout.CENTER)

        // Navigate to source on code issue selection
        codeList.addListSelectionListener { e ->
            if (e.valueIsAdjusting) return@addListSelectionListener
            val descriptor = codeList.selectedValue ?: return@addListSelectionListener
            val element = descriptor.psiElement ?: return@addListSelectionListener
            val file = element.containingFile?.virtualFile ?: return@addListSelectionListener
            val offset = element.textOffset
            TelemetryService.track(
                "toolwindow.issue_navigated",
                mapOf("file" to file.name)
            )
            ApplicationManager.getApplication().invokeLater {
                com.intellij.openapi.fileEditor.OpenFileDescriptor(project, file, offset).navigate(true)
            }
        }

        // Subscribe to active file changes
        project.messageBus.connect().subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileOpened(source: FileEditorManager, file: VirtualFile) = refresh(file)
                override fun selectionChanged(event: com.intellij.openapi.fileEditor.FileEditorManagerEvent) {
                    event.newFile?.let { refresh(it) }
                }
            }
        )

        // Refresh for current file on init
        FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.let { refresh(it) }
    }

    /** Called by RunDryRunAction after a dry run completes. */
    fun updatePlanIssues(issues: List<PlanIssue>) {
        ApplicationManager.getApplication().invokeLater {
            planModel.clear()
            issues.forEach { planModel.addElement(it) }
            planSection.isVisible = issues.isNotEmpty()
            revalidate()
            repaint()
        }
    }

    private fun refresh(virtualFile: VirtualFile) {
        if (virtualFile.extension != "py") {
            ApplicationManager.getApplication().invokeLater { codeModel.clear() }
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val allProblems = ReadAction.compute<List<ProblemDescriptor>, Throwable> {
                val psiFile = PsiManager.getInstance(project).findFile(virtualFile) ?: return@compute emptyList()
                val mgr = InspectionManager.getInstance(project)

                val results = mutableListOf<ProblemDescriptor>()

                // Run per-element inspections; track count per inspection
                for (tool in INSPECTION_TOOLS) {
                    val holder = ProblemsHolder(mgr, psiFile, false)
                    psiFile.accept(tool.buildVisitor(holder, false))
                    val count = holder.results.size
                    if (count > 0) {
                        TelemetryService.track(
                            "inspection.fired",
                            mapOf(
                                "inspection" to (tool::class.simpleName ?: "unknown"),
                                "count"      to count.toString(),
                                "file"       to virtualFile.name,
                            )
                        )
                    }
                    results.addAll(holder.results)
                }

                // Run file-level caching inspection
                val cachingProblems = SparkCachingInspection().checkFile(psiFile, mgr, false)
                if (!cachingProblems.isNullOrEmpty()) {
                    TelemetryService.track(
                        "inspection.fired",
                        mapOf(
                            "inspection" to "SparkCachingInspection",
                            "count"      to cachingProblems.size.toString(),
                            "file"       to virtualFile.name,
                        )
                    )
                    results.addAll(cachingProblems)
                }

                results
            }

            ApplicationManager.getApplication().invokeLater {
                codeModel.clear()
                allProblems.forEach { codeModel.addElement(it) }
            }
        }
    }
}
