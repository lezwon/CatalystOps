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

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Security Inspection</b></p>
        <p>Detects security vulnerabilities in PySpark code.</p>

        <h3>CODE_SQL_INJECT_001 — SQL injection via f-string</h3>
        <p>spark.sql() called with an f-string can inject arbitrary SQL if the interpolated values come
        from user input. Use parameterised queries or sanitise inputs.</p>
        <pre>
# Dangerous — SQL injection risk:
user_id = request.get("user_id")
spark.sql(f"SELECT * FROM users WHERE id = {user_id}")

# Safe alternatives:
# 1. Use spark.sql with proper sanitisation
# 2. Use DataFrame API instead:
df.filter(col("id") == user_id)
        </pre>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                if (callee.referencedName != "sql") return

                val arg = node.argumentList?.arguments?.firstOrNull() ?: return
                val text = arg.text

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
