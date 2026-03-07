package com.catalystops.quickfix

import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.jetbrains.python.psi.LanguageLevel
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementGenerator
import com.jetbrains.python.psi.PyReferenceExpression

class AddBroadcastHintFix : LocalQuickFix {

    override fun getFamilyName(): String = "Wrap join argument with broadcast()"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val call = descriptor.psiElement as? PyCallExpression ?: return
        val callee = call.callee as? PyReferenceExpression ?: return

        // Only applicable to .join() calls
        if (callee.referencedName != "join") return

        val args = call.argumentList?.arguments ?: return
        val firstArg = args.firstOrNull() ?: return

        val generator = PyElementGenerator.getInstance(project)
        val broadcastExpr = generator.createFromText(
            LanguageLevel.getDefault(),
            PyCallExpression::class.java,
            "broadcast(${firstArg.text})"
        )

        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
            firstArg.replace(broadcastExpr)
        }
        TelemetryService.track("quickfix.applied", mapOf("fix" to "AddBroadcastHintFix", "ruleId" to "CODE_COLLECT_001"))
    }
}
