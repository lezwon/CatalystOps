package com.catalystops.inspection

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyReferenceExpression

class SparkUdfInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "udf" -> holder.registerProblem(
                        node,
                        "[CODE_UDF_001] udf() disables Catalyst optimisations and adds serialisation overhead — " +
                            "prefer built-in Spark functions or pandas_udf for better performance.",
                        ProblemHighlightType.WARNING
                    )
                    "pandas_udf" -> holder.registerProblem(
                        node,
                        "[CODE_PANDAS_UDF_001] pandas_udf() uses vectorised execution but still crosses the JVM boundary — " +
                            "verify that built-in functions cannot replace it.",
                        ProblemHighlightType.WEAK_WARNING
                    )
                }
            }
        }
}
