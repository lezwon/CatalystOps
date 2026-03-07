package com.catalystops.quickfix

import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.LanguageLevel
import com.jetbrains.python.psi.PyElementGenerator
import com.jetbrains.python.psi.PyExpressionStatement
import com.jetbrains.python.psi.PyStatement

class EnableAqeFix : LocalQuickFix {

    override fun getFamilyName(): String = "Insert spark.conf.set to enable AQE"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val element = descriptor.psiElement ?: return
        val file = element.containingFile ?: return
        val generator = PyElementGenerator.getInstance(project)

        val stmt = generator.createFromText(
            LanguageLevel.getDefault(),
            PyExpressionStatement::class.java,
            "spark.conf.set(\"spark.sql.adaptive.enabled\", \"true\")"
        )

        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
            // Find the containing statement and insert before it, or prepend to file
            val containingStmt = PsiTreeUtil.getParentOfType(element, PyStatement::class.java)
            if (containingStmt != null) {
                containingStmt.parent.addBefore(stmt, containingStmt)
            } else {
                file.addBefore(stmt, file.firstChild)
            }
        }
        TelemetryService.track("quickfix.applied", mapOf("fix" to "EnableAqeFix", "ruleId" to "CODE_AQE_001"))
    }
}
