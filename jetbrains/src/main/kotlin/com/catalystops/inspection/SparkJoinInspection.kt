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
                        // Flag join without any arguments (positional / accidental cross join)
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
                        // union() is positional (column order matters) — flag to suggest unionByName
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
