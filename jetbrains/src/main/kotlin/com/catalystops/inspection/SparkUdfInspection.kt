package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyReferenceExpression

class SparkUdfInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark UDF Inspection</b></p>
        <p>Detects UDF usage patterns that block Catalyst optimisations and harm performance.</p>

        <h3>CODE_UDF_001 — udf() Usage</h3>
        <p>Python UDFs disable Catalyst optimisations and add serialisation overhead on every row.</p>
        <pre>
# Instead of:
from pyspark.sql.functions import udf
my_udf = udf(lambda x: x.upper())
df.select(my_udf("col"))

# Use built-in functions:
from pyspark.sql.functions import upper
df.select(upper("col"))
        </pre>

        <h3>CODE_PANDAS_UDF_001 — pandas_udf() Usage</h3>
        <p>pandas_udf uses vectorised execution but still crosses the JVM boundary. Verify built-in
        functions cannot replace it.</p>

        <h3>CODE_UDF_FILTER_001 — UDF inside filter()</h3>
        <p>UDF or lambda calls inside filter() block predicate pushdown on Delta and partitioned tables,
        preventing partition pruning and file skipping.</p>
        <pre>
# Instead of:
df.filter(my_udf(col("status")) == "active")

# Use built-in functions:
df.filter(col("status") == "active")
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
                    "udf" -> {
                        holder.registerProblem(
                            node,
                            "[CODE_UDF_001] udf() disables Catalyst optimisations and adds serialisation overhead — " +
                                "prefer built-in Spark functions or pandas_udf for better performance.",
                            ProblemHighlightType.WARNING
                        )
                        // Also check if this udf call (or its usage) is inside a filter()
                        checkUdfInFilter(node, holder)
                    }
                    "pandas_udf" -> holder.registerProblem(
                        node,
                        "[CODE_PANDAS_UDF_001] pandas_udf() uses vectorised execution but still crosses the JVM boundary — " +
                            "verify that built-in functions cannot replace it.",
                        ProblemHighlightType.WEAK_WARNING
                    )
                    "filter", "where" -> {
                        // Check if any argument to filter contains a udf or lambda call
                        val args = node.argumentList?.arguments ?: return
                        for (arg in args) {
                            val udfCalls = PsiTreeUtil.collectElementsOfType(arg, PyCallExpression::class.java)
                            for (udfCall in udfCalls) {
                                val udfCallee = udfCall.callee as? PyReferenceExpression ?: continue
                                if (udfCallee.referencedName == "udf" ||
                                    udfCallee.referencedName == "pandas_udf"
                                ) {
                                    holder.registerProblem(
                                        udfCall,
                                        "[CODE_UDF_FILTER_001] UDF inside filter() blocks predicate pushdown on Delta and partitioned tables. Use built-in functions instead.",
                                        ProblemHighlightType.WARNING
                                    )
                                }
                            }
                        }
                    }
                }
            }

            private fun checkUdfInFilter(node: PyCallExpression, holder: ProblemsHolder) {
                // Check if this udf definition is immediately inside a filter argument
                val parentCall = PsiTreeUtil.getParentOfType(node, PyCallExpression::class.java) ?: return
                val parentCallee = parentCall.callee as? PyReferenceExpression ?: return
                if (parentCallee.referencedName == "filter" || parentCallee.referencedName == "where") {
                    holder.registerProblem(
                        node,
                        "[CODE_UDF_FILTER_001] UDF inside filter() blocks predicate pushdown on Delta and partitioned tables. Use built-in functions instead.",
                        ProblemHighlightType.WARNING
                    )
                }
            }
        }
}
