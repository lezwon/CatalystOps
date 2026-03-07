package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyExpression
import com.jetbrains.python.psi.PyReferenceExpression

class SparkShuffleInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "orderBy", "sort" -> {
                        // Flag global sort that is NOT inside a Window chain (no partitionBy in qualifier chain)
                        if (!chainContains(callee.qualifier, "partitionBy")) {
                            holder.registerProblem(
                                node,
                                "[CODE_SORT_001] Global ${callee.referencedName}() triggers a full shuffle across all partitions. " +
                                    "Use sortWithinPartitions() or apply ordering only at the final write step.",
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
