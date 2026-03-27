package com.catalystops.inspection

import com.catalystops.quickfix.AddBroadcastHintFix
import com.catalystops.quickfix.ReplaceCrossJoinFix
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyStringLiteralExpression

class SparkJoinInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Join Inspection</b></p>
        <p>Detects inefficient or dangerous join patterns that cause Cartesian products, positional mismatches,
        or missed broadcast opportunities.</p>

        <h3>CODE_CROSSJOIN_001 — crossJoin() Cartesian product</h3>
        <p>crossJoin() produces a Cartesian product (N × M rows). Supply explicit join keys instead.</p>
        <pre>
# Instead of:
df1.crossJoin(df2)

# Use:
df1.join(df2, "key_column")
        </pre>

        <h3>CODE_JOIN_001 — join() without arguments</h3>
        <p>join() called without arguments accidentally creates a cross join. Specify join keys and type.</p>
        <pre>
# Instead of:
df1.join(df2)

# Use:
df1.join(df2, df1.id == df2.id, "inner")
        </pre>

        <h3>CODE_UNION_001 — union() positional merge</h3>
        <p>union() merges by column position. Use unionByName() to merge by column name and avoid
        silent mismatches when column order differs between DataFrames.</p>
        <pre>
# Instead of:
df1.union(df2)

# Use:
df1.unionByName(df2)
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
                    "crossJoin" -> holder.registerProblem(
                        node,
                        "[CODE_CROSSJOIN_001] crossJoin() produces a Cartesian product — supply explicit join keys instead.",
                        ProblemHighlightType.WARNING,
                        ReplaceCrossJoinFix()
                    )
                    "join" -> {
                        val args = node.argumentList?.arguments ?: return
                        if (args.isEmpty()) {
                            holder.registerProblem(
                                node,
                                "[CODE_JOIN_001] join() called without arguments — specify join keys and type.",
                                ProblemHighlightType.WARNING
                            )
                        }
                    }
                    "union" -> {
                        holder.registerProblem(
                            node,
                            "[CODE_UNION_001] union() merges by column position. Use unionByName() to merge by column name and avoid silent mismatches.",
                            ProblemHighlightType.WEAK_WARNING
                        )
                    }
                }
            }
        }
}
