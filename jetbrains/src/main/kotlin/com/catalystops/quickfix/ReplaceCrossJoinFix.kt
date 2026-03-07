package com.catalystops.quickfix

import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.jetbrains.python.psi.LanguageLevel
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementGenerator
import com.jetbrains.python.psi.PyReferenceExpression

class ReplaceCrossJoinFix : LocalQuickFix {

    override fun getFamilyName(): String = "Replace crossJoin() with join() on explicit key"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val crossJoinCall = descriptor.psiElement as? PyCallExpression ?: return
        val callee = crossJoinCall.callee as? PyReferenceExpression ?: return
        val rightDf = crossJoinCall.argumentList?.arguments?.firstOrNull()?.text ?: "df2"

        // Ask user for the join key on the EDT
        ApplicationManager.getApplication().invokeLater {
            val key = Messages.showInputDialog(
                project,
                "Enter the join key column name:",
                "Replace crossJoin with join",
                Messages.getQuestionIcon()
            ) ?: return@invokeLater

            val generator = PyElementGenerator.getInstance(project)
            val newCall = generator.createFromText(
                LanguageLevel.getDefault(),
                PyCallExpression::class.java,
                "df.join($rightDf, \"$key\")"
            )

            com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
                // Replace only the method name and arguments, preserve the qualifier
                val qualifierText = callee.qualifier?.text ?: return@runWriteCommandAction
                val replacement = generator.createFromText(
                    LanguageLevel.getDefault(),
                    PyCallExpression::class.java,
                    "$qualifierText.join($rightDf, \"$key\")"
                )
                crossJoinCall.replace(replacement)
            }
            TelemetryService.track("quickfix.applied", mapOf("fix" to "ReplaceCrossJoinFix", "ruleId" to "CODE_CROSSJOIN_001"))
        }
    }
}
