package com.catalystops.quickfix

import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.LanguageLevel
import com.jetbrains.python.psi.PyAssignmentStatement
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementGenerator
import com.jetbrains.python.psi.PyExpressionStatement
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyTargetExpression

class AddCacheFix : LocalQuickFix {

    override fun getFamilyName(): String = "Insert df = df.cache() before first action"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val element = descriptor.psiElement ?: return

        // The element is a call expression like df.count() — get the qualifier (df)
        val call = element as? PyCallExpression ?: return
        val callee = call.callee as? PyReferenceExpression ?: return
        val varName = callee.qualifier?.text ?: run {
            // Try to get varName from the problem element's context
            val assignment = PsiTreeUtil.getParentOfType(element, PyAssignmentStatement::class.java)
            val target = assignment?.targets?.firstOrNull() as? PyTargetExpression
            target?.name ?: return
        }

        val generator = PyElementGenerator.getInstance(project)
        val cacheStmt = generator.createFromText(
            LanguageLevel.getDefault(),
            PyExpressionStatement::class.java,
            "$varName = $varName.cache()"
        )

        // Insert the cache statement before the containing statement
        val containingStmt = PsiTreeUtil.getParentOfType(
            element,
            com.jetbrains.python.psi.PyStatement::class.java
        ) ?: return

        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
            containingStmt.parent.addBefore(cacheStmt, containingStmt)
        }
        TelemetryService.track(
            "quickfix.applied",
            mapOf("fix" to "AddCacheFix", "ruleId" to "CODE_REPEATED_ACTIONS_001")
        )
    }
}
