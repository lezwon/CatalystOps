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

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Write Inspection</b></p>
        <p>Detects write patterns that can silently overwrite data or create bottlenecks.</p>

        <h3>CODE_WRITE_MODE_001 — Write without .mode()</h3>
        <p>Write operations without .mode() may silently overwrite or fail depending on the format.
        Always specify .mode("overwrite") or .mode("append") explicitly.</p>
        <pre>
# Instead of:
df.write.parquet("output/")

# Use:
df.write.mode("overwrite").parquet("output/")
        </pre>

        <h3>CODE_COALESCE_001 — coalesce(1) / repartition(1)</h3>
        <p>Coalescing or repartitioning to a single partition forces all data through one executor,
        creating a bottleneck and possible OOM. Use a higher partition count.</p>
        <pre>
# Instead of:
df.coalesce(1).write.csv("output/")

# Use:
df.write.csv("output/")  # let Spark decide partition count
# or a reasonable number:
df.coalesce(8).write.csv("output/")
        </pre>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "save", "saveAsTable", "insertInto" -> {
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
                        if (arg != null && arg.bigIntegerValue.toInt() == 1) {
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
