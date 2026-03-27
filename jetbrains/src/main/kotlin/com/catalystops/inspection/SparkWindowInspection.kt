package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyExpression
import com.jetbrains.python.psi.PyReferenceExpression

class SparkWindowInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Window Inspection</b></p>
        <p>Detects Window function usage patterns that cause a single-partition bottleneck.</p>

        <h3>CODE_WINDOW_001 — Window.orderBy() without partitionBy()</h3>
        <p>Window.orderBy() without partitionBy() creates a single partition containing all data,
        which defeats the purpose of distributed processing and causes OOM on large datasets.</p>
        <pre>
# Instead of:
window = Window.orderBy("timestamp")

# Use:
window = Window.partitionBy("user_id").orderBy("timestamp")
        </pre>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                if (callee.referencedName != "orderBy") return

                // Only flag Window.orderBy() — check that the qualifier chain contains "Window"
                if (!chainContainsRef(callee.qualifier, "Window") &&
                    !chainContainsRef(callee.qualifier, "window")
                ) return

                if (!chainContains(callee.qualifier, "partitionBy")) {
                    holder.registerProblem(
                        node,
                        "[CODE_WINDOW_001] Window.orderBy() without partitionBy() — this creates a single partition containing all data. " +
                            "Add .partitionBy(col) to distribute the window computation.",
                        ProblemHighlightType.WARNING
                    )
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

            private fun chainContainsRef(expr: PyExpression?, refName: String): Boolean {
                var cur = expr
                while (cur != null) {
                    val node = cur
                    if (node is PyReferenceExpression && node.referencedName == refName) return true
                    if (node is PyCallExpression) {
                        val c = node.callee as? PyReferenceExpression ?: break
                        cur = c.qualifier
                    } else break
                }
                return false
            }
        }
}
