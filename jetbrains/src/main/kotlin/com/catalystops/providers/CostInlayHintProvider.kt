package com.catalystops.providers

import com.catalystops.analysis.StaticCostEstimator
import com.catalystops.settings.DatabricksSettings
import com.intellij.codeInsight.hints.ChangeListener
import com.intellij.codeInsight.hints.ImmediateConfigurable
import com.intellij.codeInsight.hints.InlayHintsCollector
import com.intellij.codeInsight.hints.InlayHintsProvider
import com.intellij.codeInsight.hints.InlayHintsSink
import com.intellij.codeInsight.hints.SettingsKey
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiFile
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Inlay hint provider for Python files — shows estimated cost on `# @compute:` annotation lines.
 *
 * Example:
 *   # @compute: nodes=4, cores=2, memory=16GB, rate=0.25     estimated cost: ~$0.0042
 */
@Suppress("UnstableApiUsage")
class CostInlayHintProvider : InlayHintsProvider<CostInlayHintProvider.Settings> {

    data class Settings(var enabled: Boolean = true)

    override val key: SettingsKey<Settings> = SettingsKey("catalystops.cost.inlay")
    override val name: String = "CatalystOps: Estimated Cost"
    override val previewText: String = "# @compute: nodes=4, cores=2, memory=16GB, rate=0.25"

    override fun createSettings(): Settings = Settings()

    override fun createConfigurable(settings: Settings): ImmediateConfigurable {
        return object : ImmediateConfigurable {
            override fun createComponent(listener: ChangeListener): JComponent = JPanel()
        }
    }

    override fun getCollectorFor(
        file: PsiFile,
        editor: Editor,
        settings: Settings,
        sink: InlayHintsSink,
    ): InlayHintsCollector? {
        if (!settings.enabled) return null
        if (file.virtualFile?.extension != "py") return null

        return CostInlayHintsCollector(editor, sink, file.project)
    }
}

@Suppress("UnstableApiUsage")
private class CostInlayHintsCollector(
    private val editor: Editor,
    private val sink: InlayHintsSink,
    private val project: com.intellij.openapi.project.Project,
) : InlayHintsCollector {

    override fun collect(element: com.intellij.psi.PsiElement, editor: Editor, sink: InlayHintsSink): Boolean {
        // Only process the root file element (avoid processing every child)
        if (element.parent != null && element.parent !is PsiFile) return true

        val file = element.containingFile ?: return true
        val code = file.text ?: return true

        val estimate = StaticCostEstimator.estimateStaticCost(code) ?: return true

        val settings = DatabricksSettings.getInstance(project).state
        val dbuRate = settings.dbuRatePerHour

        // Apply the configured DBU rate if it differs from the annotation rate
        val displayCost = if (dbuRate != estimate.computeSpec.ratePerHour && estimate.annotations.isNotEmpty()) {
            // Recalculate with configured rate
            val totalBytes = estimate.annotations.sumOf { it.sizeBytes }
            val totalDataGB = totalBytes / (1024.0 * 1024.0 * 1024.0)
            val throughputGBPerHour = estimate.computeSpec.nodes * 100.0
            val scanHours = if (throughputGBPerHour > 0) totalDataGB / throughputGBPerHour else 0.0
            val dollars = scanHours * dbuRate * estimate.computeSpec.nodes * estimate.computeSpec.overheadFactor
            when {
                totalBytes == 0L -> "unknown"
                dollars < 0.0001 -> "<\$0.0001"
                else -> "~\$${String.format("%.4f", dollars)}"
            }
        } else {
            estimate.formattedCost
        }

        // Place hint at end of the @compute annotation line
        val annotationLine = estimate.computeSpec.annotationLine
        val document = editor.document
        if (annotationLine >= document.lineCount) return true

        val lineEndOffset = document.getLineEndOffset(annotationLine)

        val factory = com.intellij.codeInsight.hints.presentation.PresentationFactory(editor)
        val text = factory.smallText("  estimated cost: $displayCost")

        sink.addInlineElement(lineEndOffset, relatesToPrecedingText = true, text, placeAtTheEndOfLine = false)

        return true
    }
}
