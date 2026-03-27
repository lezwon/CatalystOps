package com.catalystops.quickfix

import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.LanguageLevel
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementGenerator
import com.jetbrains.python.psi.PyReferenceExpression

class AddWatermarkFix : LocalQuickFix {

    override fun getFamilyName(): String = "Insert .withWatermark() before groupBy()"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val groupByCall = descriptor.psiElement as? PyCallExpression ?: return
        val callee = groupByCall.callee as? PyReferenceExpression ?: return
        if (callee.referencedName != "groupBy") return

        val qualifierText = callee.qualifier?.text ?: return
        val groupByArgsText = groupByCall.argumentList?.text ?: "()"

        val generator = PyElementGenerator.getInstance(project)
        // Insert withWatermark with a TODO comment for the timestamp column
        val replacement = generator.createFromText(
            LanguageLevel.getDefault(),
            PyCallExpression::class.java,
            "$qualifierText.withWatermark(\"TODO: timestamp_col\", \"10 minutes\").groupBy$groupByArgsText"
        )

        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
            groupByCall.replace(replacement)
        }
        TelemetryService.track(
            "quickfix.applied",
            mapOf("fix" to "AddWatermarkFix", "ruleId" to "CODE_STREAMING_WATERMARK_001")
        )
    }
}
