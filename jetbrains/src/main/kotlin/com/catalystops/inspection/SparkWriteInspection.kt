package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyExpression
import com.jetbrains.python.psi.PyNumericLiteralExpression
import com.jetbrains.python.psi.PyReferenceExpression

class SparkWriteInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "save", "saveAsTable", "insertInto" -> {
                        // Flag write() chain that does not include .mode(...)
                        if (!chainContains(callee.qualifier, "mode")) {
                            holder.registerProblem(
                                node,
                                "[CODE_WRITE_MODE_001] Write operation without .mode() — data may be overwritten or duplicated silently. Add .mode(\"overwrite\") or .mode(\"append\").",
                                ProblemHighlightType.WARNING
                            )
                        }
                    }
                    "coalesce", "repartition" -> {
                        val arg = node.argumentList?.arguments?.firstOrNull() as? PyNumericLiteralExpression
                        if (arg != null && arg.bigIntegerValue?.toInt() == 1) {
                            holder.registerProblem(
                                node,
                                "[CODE_COALESCE_001] ${callee.referencedName}(1) forces all data to a single partition — this creates a bottleneck. Use a higher partition count.",
                                ProblemHighlightType.WARNING
                            )
                        }
                    }
                }
            }

            private fun chainContains(expr: PyExpression?, methodName: String): Boolean {
                var cur = expr
                while (cur != null) {
                    val node = cur
                    if (node is PyCallExpression) {
                        val c = node.callee as? PyReferenceExpression ?: break
                        if (c.referencedName == methodName) return true
                        cur = c.qualifier
                    } else break
                }
                return false
            }
        }
}
