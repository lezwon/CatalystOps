package com.catalystops.quickfix

import com.catalystops.telemetry.TelemetryService
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.openapi.project.Project
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.LanguageLevel
import com.jetbrains.python.psi.PyAssignmentStatement
import com.jetbrains.python.psi.PyElementGenerator
import com.jetbrains.python.psi.PyExpressionStatement
import com.jetbrains.python.psi.PyTargetExpression

class AddPersistFix : LocalQuickFix {

    override fun getFamilyName(): String = "Insert df.persist() after assignment"

    override fun applyFix(project: Project, descriptor: ProblemDescriptor) {
        val element = descriptor.psiElement ?: return
        val assignment = PsiTreeUtil.getParentOfType(element, PyAssignmentStatement::class.java) ?: return
        val target = assignment.targets.firstOrNull() as? PyTargetExpression ?: return
        val varName = target.name ?: return

        val generator = PyElementGenerator.getInstance(project)
        val persistStmt = generator.createFromText(
            LanguageLevel.getDefault(),
            PyExpressionStatement::class.java,
            "$varName = $varName.persist()"
        )

        com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
            assignment.parent.addAfter(persistStmt, assignment)
        }
        TelemetryService.track("quickfix.applied", mapOf("fix" to "AddPersistFix", "ruleId" to "CODE_REPRO_001"))
    }
}
