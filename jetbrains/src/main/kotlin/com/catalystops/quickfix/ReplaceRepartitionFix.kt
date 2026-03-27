package com.catalystops.quickfix

import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.jetbrains.python.psi.LanguageLevel
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementGenerator
import com.jetbrains.python.psi.PyReferenceExpression

class ReplaceRepartitionFix : LocalQuickFix {

    override fun getFamilyName(): String = "Replace repartition() with coalesce()"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val repartitionCall = descriptor.psiElement as? PyCallExpression ?: return
        val callee = repartitionCall.callee as? PyReferenceExpression ?: return
        if (callee.referencedName != "repartition") return

        val argsText = repartitionCall.argumentList?.text ?: "()"
        val qualifierText = callee.qualifier?.text ?: return

        val generator = PyElementGenerator.getInstance(project)
        val replacement = generator.createFromText(
            LanguageLevel.getDefault(),
            PyCallExpression::class.java,
            "$qualifierText.coalesce$argsText"
        )

        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
            repartitionCall.replace(replacement)
        }
        TelemetryService.track(
            "quickfix.applied",
            mapOf("fix" to "ReplaceRepartitionFix", "ruleId" to "CODE_REPARTITION_WRITE_001")
        )
    }
}
