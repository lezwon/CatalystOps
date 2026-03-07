package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyExpression
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyStringLiteralExpression

class SparkDeltaInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "merge" -> {
                        // Flag MERGE without an explicit whenNotMatchedInsert or whenMatchedUpdate
                        // Simple heuristic: check forward chain for at least one whenMatched/whenNotMatched
                        val parent = node.parent
                        if (parent is PyCallExpression) {
                            val parentCallee = parent.callee as? PyReferenceExpression
                            if (parentCallee?.referencedName == "execute") {
                                // .merge(...).execute() without whenMatched/whenNotMatched in chain
                                holder.registerProblem(
                                    node,
                                    "[CODE_DELTA_MERGE_001] DeltaTable.merge().execute() without whenMatched/whenNotMatched clauses — add explicit match conditions.",
                                    ProblemHighlightType.WARNING
                                )
                            }
                        }
                    }
                    "sql" -> {
                        // Flag SQL strings containing DROP TABLE followed by CREATE TABLE (recreate pattern)
                        val arg = node.argumentList?.arguments?.firstOrNull() as? PyStringLiteralExpression
                        val sqlText = arg?.stringValue?.uppercase() ?: return
                        if (sqlText.contains("DROP TABLE") && sqlText.contains("CREATE TABLE")) {
                            holder.registerProblem(
                                node,
                                "[CODE_DELTA_DROP_CREATE_001] DROP TABLE + CREATE TABLE pattern destroys Delta history — use TRUNCATE or overwrite mode instead.",
                                ProblemHighlightType.WARNING
                            )
                        }
                        // Flag missing OPTIMIZE / Z-ORDER hints (informational)
                        if (sqlText.contains("INSERT INTO") && !sqlText.contains("OPTIMIZE")) {
                            holder.registerProblem(
                                node,
                                "[CODE_DELTA_OPTIMIZE_001] Consider running OPTIMIZE with Z-ORDER after bulk inserts to improve Delta read performance.",
                                ProblemHighlightType.WEAK_WARNING
                            )
                        }
                    }
                    "dlt" -> holder.registerProblem(
                        node,
                        "[CODE_DLT_001] Ensure DLT pipeline tables use @dlt.table decorator with explicit schema and quality expectations.",
                        ProblemHighlightType.WEAK_WARNING
                    )
                }
            }
        }
}
