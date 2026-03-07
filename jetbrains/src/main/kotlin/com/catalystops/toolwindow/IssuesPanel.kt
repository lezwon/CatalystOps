package com.catalystops.toolwindow

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
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.OpenSourceUtil
import com.intellij.util.ui.JBUI
import com.jetbrains.python.psi.PyFile
import java.awt.BorderLayout
import javax.swing.DefaultListModel
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

    private val model = DefaultListModel<ProblemDescriptor>()
    private val list = JBList(model).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = IssueCellRenderer()
    }

    init {
        border = JBUI.Borders.empty(4)
        add(JBScrollPane(list), BorderLayout.CENTER)

        // Navigate to source on selection
        list.addListSelectionListener { e ->
            if (e.valueIsAdjusting) return@addListSelectionListener
            val descriptor = list.selectedValue ?: return@addListSelectionListener
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

    private fun refresh(virtualFile: VirtualFile) {
        if (virtualFile.extension != "py") {
            ApplicationManager.getApplication().invokeLater { model.clear() }
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
                model.clear()
                allProblems.forEach { model.addElement(it) }
            }
        }
    }
}
