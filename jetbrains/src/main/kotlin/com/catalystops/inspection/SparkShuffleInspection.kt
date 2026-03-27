package com.catalystops.inspection

import com.catalystops.quickfix.ReplaceRepartitionFix
import com.intellij.codeInspection.InspectionManager
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.PyAssignmentStatement
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyExpression
import com.jetbrains.python.psi.PyReferenceExpression

class SparkShuffleInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Shuffle Inspection</b></p>
        <p>Detects operations that cause unnecessary full shuffles across the cluster.</p>

        <h3>CODE_SORT_001 — Global sort / shuffle</h3>
        <p>Global orderBy() / sort() triggers a full shuffle across all partitions, which is very expensive
        on large datasets.</p>
        <pre>
# Instead of:
df.orderBy("col")

# Use:
df.sortWithinPartitions("col")
# or sort only at the final write step
        </pre>

        <h3>CODE_REPARTITION_WRITE_001 — repartition() before write</h3>
        <p>repartition() before write causes a full shuffle. Use coalesce() to reduce partitions without a
        shuffle when decreasing partition count.</p>
        <pre>
# Instead of:
df.repartition(10).write.parquet("output/")

# Use:
df.coalesce(10).write.parquet("output/")
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

    override fun checkFile(
        file: PsiFile,
        manager: InspectionManager,
        isOnTheFly: Boolean,
    ): Array<ProblemDescriptor> {
        val problems = mutableListOf<ProblemDescriptor>()

        // CODE_REPARTITION_WRITE_001: repartition() followed within a few lines by write/saveAsTable/save
        val text = file.text ?: return emptyArray()
        val lines = text.lines()

        for (i in lines.indices) {
            val line = lines[i]
            if (!line.contains(".repartition(")) continue

            // Check the next 5 lines for write operations
            val windowEnd = minOf(i + 6, lines.size)
            val windowText = lines.subList(i, windowEnd).joinToString("\n")
            if (windowText.contains(".write") || windowText.contains(".saveAsTable(") || windowText.contains(".save(")) {
                // Find the PSI element for the repartition call
                val lineOffset = lines.subList(0, i).sumOf { it.length + 1 }
                val colOffset = line.indexOf(".repartition(")
                val elementOffset = lineOffset + colOffset
                val element = file.findElementAt(elementOffset + 1) ?: continue
                val callExpr = PsiTreeUtil.getParentOfType(element, PyCallExpression::class.java) ?: continue
                val callCallee = callExpr.callee as? PyReferenceExpression ?: continue
                if (callCallee.referencedName == "repartition") {
                    problems.add(
                        manager.createProblemDescriptor(
                            callExpr,
                            "[CODE_REPARTITION_WRITE_001] repartition() before write causes a full shuffle. Use coalesce() to reduce partitions without a shuffle.",
                            isOnTheFly,
                            arrayOf(ReplaceRepartitionFix()),
                            ProblemHighlightType.WARNING
                        )
                    )
                }
            }
        }

        return problems.toTypedArray()
    }
}
