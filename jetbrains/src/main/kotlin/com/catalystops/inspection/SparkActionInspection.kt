package com.catalystops.inspection

import com.catalystops.quickfix.AddBroadcastHintFix
import com.intellij.codeInspection.InspectionManager
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.PsiFile
import com.jetbrains.python.psi.PyBinaryExpression
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyReferenceExpression

class SparkActionInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Action Inspection</b></p>
        <p>Detects expensive Spark action calls that bring large amounts of data to the driver or trigger
        full dataset materialisation.</p>

        <h3>CODE_COLLECT_001 — collect() Usage</h3>
        <p>Pulls all data from all executors to the driver node. On large datasets this causes OutOfMemoryError.</p>
        <pre>
# Instead of:
data = df.collect()

# Use:
data = df.take(1000)
# or write to storage:
df.write.parquet("path/to/output")
        </pre>

        <h3>CODE_ITER_COLLECT_001 — for-loop over collect()</h3>
        <p>Iterating row-by-row on the driver after collect() defeats the purpose of distributed processing.</p>
        <pre>
# Instead of:
for row in df.collect():
    process(row)

# Use:
df.foreach(process)
# or write results:
df.write.parquet("output/")
        </pre>

        <h3>CODE_SHOW_001 — show() in production</h3>
        <p>show() triggers a full compute stage. Use write() to persist results in production.</p>

        <h3>CODE_COUNT_001 — count() in comparison</h3>
        <p>count() &gt; 0 scans the entire dataset. Use limit(1).count() or isEmpty() instead.</p>

        <h3>CODE_PANDAS_001 — toPandas / toLocalIterator</h3>
        <p>Brings all data to the driver. Ensure the dataset is small or use sampling first.</p>

        <h3>CODE_DISPLAY_001 — display() in production</h3>
        <p>display() triggers full compute. Remove or replace with a write in production code.</p>

        <h3>CODE_FOREACH_001 — foreach / foreachPartition</h3>
        <p>Forces full dataset materialisation. Consider write() instead.</p>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "collect" -> holder.registerProblem(
                        node,
                        "[CODE_COLLECT_001] collect() pulls all data to the driver — use take(n), limit(n), or write to storage instead.",
                        ProblemHighlightType.WARNING,
                        AddBroadcastHintFix()
                    )
                    "show" -> holder.registerProblem(
                        node,
                        "[CODE_SHOW_001] show() in production code triggers full compute — use write() to persist results.",
                        ProblemHighlightType.WEAK_WARNING
                    )
                    "count" -> {
                        val parent = node.parent
                        if (parent is PyBinaryExpression) {
                            holder.registerProblem(
                                node,
                                "[CODE_COUNT_001] count() > 0 triggers full computation — use limit(1).count() or isEmpty() instead.",
                                ProblemHighlightType.WEAK_WARNING
                            )
                        }
                    }
                    "toPandas", "to_pandas_on_spark", "toLocalIterator" ->
                        holder.registerProblem(
                            node,
                            "[CODE_PANDAS_001] ${callee.referencedName}() brings all data to the driver — ensure the dataset is small or use sampling.",
                            ProblemHighlightType.WARNING
                        )
                    "display" -> holder.registerProblem(
                        node,
                        "[CODE_DISPLAY_001] display() in production code triggers full compute — remove or replace with a write.",
                        ProblemHighlightType.WEAK_WARNING
                    )
                    "foreach", "foreachPartition" -> holder.registerProblem(
                        node,
                        "[CODE_FOREACH_001] ${callee.referencedName}() forces full dataset materialisation — consider write() instead.",
                        ProblemHighlightType.WEAK_WARNING
                    )
                }
            }
        }

    override fun checkFile(
        file: PsiFile,
        manager: InspectionManager,
        isOnTheFly: Boolean,
    ): Array<ProblemDescriptor> {
        val problems = mutableListOf<ProblemDescriptor>()
        val text = file.text ?: return emptyArray()

        // CODE_ITER_COLLECT_001: detect `for ... in .*\.collect()` pattern
        val iterCollectRegex = Regex("""for\s+\w[\w,\s]*\s+in\s+\w[\w.]*\.collect\(\)""")
        if (iterCollectRegex.containsMatchIn(text)) {
            // Report on file level using the first match offset
            val match = iterCollectRegex.find(text) ?: return problems.toTypedArray()
            val element = file.findElementAt(match.range.first) ?: file.firstChild ?: return problems.toTypedArray()
            problems.add(
                manager.createProblemDescriptor(
                    element,
                    "[CODE_ITER_COLLECT_001] for-loop over collect() iterates row-by-row on the driver. Use df.foreach() or write to storage instead.",
                    isOnTheFly,
                    emptyArray(),
                    ProblemHighlightType.WARNING
                )
            )
        }

        return problems.toTypedArray()
    }
}
