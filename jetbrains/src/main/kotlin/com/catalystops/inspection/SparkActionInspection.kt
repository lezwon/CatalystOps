package com.catalystops.inspection

import com.catalystops.quickfix.AddBroadcastHintFix
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyBinaryExpression
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyReferenceExpression

class SparkActionInspection : LocalInspectionTool() {

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
}
