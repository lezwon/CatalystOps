package com.catalystops.inspection

import com.intellij.codeInspection.InspectionManager
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyExpression
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyStringLiteralExpression

class SparkDeltaInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — Delta Lake / DLT Inspection</b></p>
        <p>Detects Delta Lake and DLT anti-patterns that degrade performance, correctness, or data quality.</p>

        <h3>CODE_DELTA_MERGE_001 — DeltaTable.merge() without match clauses</h3>
        <p>merge().execute() without whenMatched/whenNotMatched clauses is likely a mistake.</p>

        <h3>CODE_DELTA_DROP_CREATE_001 — DROP TABLE + CREATE TABLE</h3>
        <p>This pattern destroys Delta history. Use TRUNCATE or overwrite mode instead.</p>

        <h3>CODE_DELTA_OPTIMIZE_001 — Missing OPTIMIZE after bulk insert</h3>
        <p>Consider running OPTIMIZE with Z-ORDER after bulk inserts for better read performance.</p>

        <h3>CODE_DLT_001 — DLT table decorator</h3>
        <p>Ensure DLT pipeline tables use @dlt.table decorator with explicit schema and quality expectations.</p>

        <h3>CODE_MERGE_DV_001 — MERGE without Deletion Vectors</h3>
        <p>MERGE without Deletion Vectors enabled is slower on large tables. Enable with
        spark.conf.set('spark.databricks.delta.properties.defaults.enableDeletionVectors', 'true').</p>

        <h3>CODE_OPTIMIZE_MERGE_001 — OPTIMIZE after every MERGE in a loop</h3>
        <p>Running OPTIMIZE after every MERGE causes latency spikes. Run OPTIMIZE on a schedule instead.</p>
        <pre>
# Instead of (inside a loop):
for batch in batches:
    delta_table.merge(...).execute()
    spark.sql("OPTIMIZE my_table")

# Run OPTIMIZE separately on a schedule or after all merges complete
        </pre>

        <h3>CODE_FLOAT_FINANCIAL_001 — FLOAT/DOUBLE for financial columns</h3>
        <p>FLOAT/DOUBLE loses precision for financial values. Use DecimalType(precision, scale) instead.</p>
        <pre>
# Instead of:
StructField("price", FloatType())

# Use:
StructField("price", DecimalType(18, 4))
        </pre>

        <h3>CODE_DLT_CDC_ORDER_001 — APPLY CHANGES CDC clause order</h3>
        <p>APPLY AS DELETE WHEN clause order in CDC pipeline is incorrect and will produce wrong results.</p>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "merge" -> {
                        val parent = node.parent
                        if (parent is PyCallExpression) {
                            val parentCallee = parent.callee as? PyReferenceExpression
                            if (parentCallee?.referencedName == "execute") {
                                holder.registerProblem(
                                    node,
                                    "[CODE_DELTA_MERGE_001] DeltaTable.merge().execute() without whenMatched/whenNotMatched clauses — add explicit match conditions.",
                                    ProblemHighlightType.WARNING
                                )
                            }
                        }
                        // CODE_MERGE_DV_001: merge without deletion vectors config
                        val fileText = node.containingFile?.text ?: ""
                        if (!fileText.contains("enableDeletionVectors")) {
                            holder.registerProblem(
                                node,
                                "[CODE_MERGE_DV_001] MERGE without Deletion Vectors enabled is slower on large tables. Enable with spark.conf.set('spark.databricks.delta.properties.defaults.enableDeletionVectors', 'true').",
                                ProblemHighlightType.INFORMATION
                            )
                        }
                    }
                    "sql" -> {
                        val arg = node.argumentList?.arguments?.firstOrNull() as? PyStringLiteralExpression
                        val sqlText = arg?.stringValue?.uppercase() ?: return
                        if (sqlText.contains("DROP TABLE") && sqlText.contains("CREATE TABLE")) {
                            holder.registerProblem(
                                node,
                                "[CODE_DELTA_DROP_CREATE_001] DROP TABLE + CREATE TABLE pattern destroys Delta history — use TRUNCATE or overwrite mode instead.",
                                ProblemHighlightType.WARNING
                            )
                        }
                        if (sqlText.contains("INSERT INTO") && !sqlText.contains("OPTIMIZE")) {
                            holder.registerProblem(
                                node,
                                "[CODE_DELTA_OPTIMIZE_001] Consider running OPTIMIZE with Z-ORDER after bulk inserts to improve Delta read performance.",
                                ProblemHighlightType.WEAK_WARNING
                            )
                        }
                        // CODE_DLT_CDC_ORDER_001: APPLY CHANGES INTO with DELETE before TRUNCATE in wrong order
                        if (sqlText.contains("APPLY CHANGES INTO")) {
                            val deleteIdx = sqlText.indexOf("APPLY AS DELETE WHEN")
                            val truncateIdx = sqlText.indexOf("APPLY AS TRUNCATE WHEN")
                            if (deleteIdx != -1 && truncateIdx != -1 && deleteIdx > truncateIdx) {
                                holder.registerProblem(
                                    node,
                                    "[CODE_DLT_CDC_ORDER_001] APPLY AS DELETE WHEN clause order in CDC pipeline is incorrect and will produce wrong results.",
                                    ProblemHighlightType.ERROR
                                )
                            }
                        }
                    }
                    "dlt" -> holder.registerProblem(
                        node,
                        "[CODE_DLT_001] Ensure DLT pipeline tables use @dlt.table decorator with explicit schema and quality expectations.",
                        ProblemHighlightType.WEAK_WARNING
                    )
                    // CODE_FLOAT_FINANCIAL_001: FloatType/DoubleType in financial StructField
                    "FloatType", "DoubleType" -> {
                        val structField = findEnclosingStructField(node)
                        if (structField != null) {
                            val fieldNameArg = structField.argumentList?.arguments?.firstOrNull()
                            val fieldName = (fieldNameArg as? PyStringLiteralExpression)?.stringValue?.lowercase() ?: ""
                            val financialTerms = listOf("price", "amount", "cost", "total", "revenue", "fee", "salary")
                            if (financialTerms.any { fieldName.contains(it) }) {
                                holder.registerProblem(
                                    node,
                                    "[CODE_FLOAT_FINANCIAL_001] FLOAT/DOUBLE loses precision for financial values. Use DecimalType(precision, scale) instead.",
                                    ProblemHighlightType.WARNING
                                )
                            }
                        }
                    }
                }
            }

            private fun findEnclosingStructField(node: PyCallExpression): PyCallExpression? {
                var cur: com.intellij.psi.PsiElement? = node.parent
                while (cur != null) {
                    if (cur is PyCallExpression) {
                        val c = cur.callee as? PyReferenceExpression
                        if (c?.referencedName == "StructField") return cur
                    }
                    cur = cur.parent
                    // Stop searching beyond a statement
                    if (cur is com.jetbrains.python.psi.PyStatement) break
                }
                return null
            }
        }

    override fun checkFile(
        file: PsiFile,
        manager: InspectionManager,
        isOnTheFly: Boolean,
    ): Array<ProblemDescriptor> {
        val problems = mutableListOf<ProblemDescriptor>()
        val text = file.text ?: return emptyArray()

        // CODE_OPTIMIZE_MERGE_001: OPTIMIZE inside a loop that also contains merge
        // Look for loop patterns with both merge and OPTIMIZE
        val hasMerge = text.contains(".merge(") || text.contains("merge(")
        val hasOptimize = text.contains("OPTIMIZE") || text.contains("optimize(")
        if (hasMerge && hasOptimize) {
            // Check if OPTIMIZE appears within a for/while block that also contains merge
            val forLoopRegex = Regex("""for\s+\w[\w,\s]*\s+in\s+""")
            val whileLoopRegex = Regex("""while\s+""")
            val isInLoop = forLoopRegex.containsMatchIn(text) || whileLoopRegex.containsMatchIn(text)
            if (isInLoop) {
                // Find a merge call to attach the problem to
                val allCalls = PsiTreeUtil.collectElementsOfType(file, PyCallExpression::class.java)
                val mergeCalls = allCalls.filter { call ->
                    val c = call.callee as? PyReferenceExpression
                    c?.referencedName == "merge"
                }
                if (mergeCalls.isNotEmpty()) {
                    problems.add(
                        manager.createProblemDescriptor(
                            mergeCalls.first(),
                            "[CODE_OPTIMIZE_MERGE_001] Running OPTIMIZE after every MERGE causes latency spikes. Run OPTIMIZE on a schedule instead.",
                            isOnTheFly,
                            emptyArray(),
                            ProblemHighlightType.WARNING
                        )
                    )
                }
            }
        }

        return problems.toTypedArray()
    }
}
