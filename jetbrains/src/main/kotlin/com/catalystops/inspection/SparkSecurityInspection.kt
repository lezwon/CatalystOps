package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyFormattedStringElement
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyStringLiteralExpression

class SparkSecurityInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                if (callee.referencedName != "sql") return

                val arg = node.argumentList?.arguments?.firstOrNull() ?: return
                val text = arg.text

                // Detect f-string argument: starts with f"/F" prefix
                val isFString = text.startsWith("f\"") || text.startsWith("f'") ||
                    text.startsWith("F\"") || text.startsWith("F'") ||
                    arg is PyFormattedStringElement ||
                    (arg is PyStringLiteralExpression && arg.children.any { it is PyFormattedStringElement })

                if (isFString || arg.children.any { it.text.startsWith("f\"") || it.text.startsWith("f'") }) {
                    holder.registerProblem(
                        arg,
                        "[CODE_SQL_INJECT_001] SQL injection risk — spark.sql() called with an f-string. " +
                            "Use parameterised queries or sanitise inputs before interpolating into SQL.",
                        ProblemHighlightType.ERROR
                    )
                }
            }
        }
}
