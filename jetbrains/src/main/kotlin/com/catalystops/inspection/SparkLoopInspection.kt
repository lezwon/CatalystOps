package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyForStatement
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyWhileStatement

class SparkLoopInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Loop Inspection</b></p>
        <p>Detects Spark operations placed inside loops that cause plan explosion or excessive job submissions.</p>

        <h3>CODE_WITHCOL_LOOP_001 — withColumn() inside a loop</h3>
        <p>withColumn() called inside a loop creates a new query plan node per iteration. On large loops this
        causes query plan explosion and very slow planning time.</p>
        <pre>
# Instead of:
for col_name in columns:
    df = df.withColumn(col_name, transform(col(col_name)))

# Use a single select():
exprs = [transform(col(c)).alias(c) for c in columns]
df = df.select(*exprs)
        </pre>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                if (callee.referencedName != "withColumn") return

                val inLoop = PsiTreeUtil.getParentOfType(
                    node,
                    PyForStatement::class.java,
                    PyWhileStatement::class.java
                ) != null

                if (inLoop) {
                    holder.registerProblem(
                        node,
                        "[CODE_WITHCOL_LOOP_001] withColumn() called inside a loop creates a new query plan node per iteration — " +
                            "use a single select() with all expressions, or build a list and call select(*exprs) outside the loop.",
                        ProblemHighlightType.WARNING
                    )
                }
            }
        }
}
