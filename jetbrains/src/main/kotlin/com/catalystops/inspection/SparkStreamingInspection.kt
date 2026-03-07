package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyExpression
import com.jetbrains.python.psi.PyKeywordArgument
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyStringLiteralExpression

class SparkStreamingInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "writeStream" -> {
                        // Flag if queryName() is not present in the following chain
                        // (walk forward through parent call chain)
                        if (!forwardChainContains(node, "queryName")) {
                            holder.registerProblem(
                                node,
                                "[CODE_STREAM_QUERY_NAME_001] Streaming query missing .queryName() — always set a query name for observability and management.",
                                ProblemHighlightType.WARNING
                            )
                        }
                    }
                    "trigger" -> {
                        // trigger(once=True) is deprecated in favour of trigger(availableNow=True)
                        val args = node.argumentList?.arguments ?: return
                        for (arg in args) {
                            if (arg is PyKeywordArgument && arg.keyword == "once") {
                                holder.registerProblem(
                                    arg,
                                    "[CODE_STREAM_TRIGGER_001] trigger(once=True) is deprecated — use trigger(availableNow=True) for incremental batch processing.",
                                    ProblemHighlightType.WARNING
                                )
                            }
                        }
                    }
                    "option" -> {
                        // Flag missing watermark for Kafka sources
                        val args = node.argumentList?.arguments ?: return
                        if (args.any { it is PyStringLiteralExpression && it.stringValue.startsWith("kafka.") }) {
                            if (!backwardChainContains(callee.qualifier, "withWatermark")) {
                                holder.registerProblem(
                                    node,
                                    "[CODE_STREAM_WATERMARK_001] Kafka streaming source detected without withWatermark() — define a watermark to bound state size and enable late-data handling.",
                                    ProblemHighlightType.WARNING
                                )
                            }
                        }
                    }
                }
            }

            private fun forwardChainContains(start: PyCallExpression, methodName: String): Boolean {
                // Walk parent chain looking for a call with this name
                var cur: com.intellij.psi.PsiElement? = start.parent
                while (cur != null) {
                    if (cur is PyCallExpression) {
                        val c = cur.callee as? PyReferenceExpression
                        if (c?.referencedName == methodName) return true
                    }
                    cur = cur.parent
                    if (cur is com.jetbrains.python.psi.PyStatement) break
                }
                return false
            }

            private fun backwardChainContains(expr: PyExpression?, methodName: String): Boolean {
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
