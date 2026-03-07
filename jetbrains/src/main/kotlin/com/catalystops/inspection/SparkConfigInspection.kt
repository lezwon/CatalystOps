package com.catalystops.inspection

import com.catalystops.quickfix.EnableAqeFix
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyStringLiteralExpression

class SparkConfigInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                if (callee.referencedName != "set") return

                val args = node.argumentList?.arguments ?: return
                val key = (args.getOrNull(0) as? PyStringLiteralExpression)?.stringValue ?: return
                val value = (args.getOrNull(1) as? PyStringLiteralExpression)?.stringValue ?: return

                when {
                    key == "spark.sql.adaptive.enabled" && value.equals("false", ignoreCase = true) ->
                        holder.registerProblem(
                            node,
                            "[CODE_AQE_001] Adaptive Query Execution (AQE) is explicitly disabled — AQE dynamically optimises query plans at runtime and should remain enabled.",
                            ProblemHighlightType.WARNING,
                            EnableAqeFix()
                        )
                    key == "spark.sql.sources.partitionOverwriteMode" && !value.equals("dynamic", ignoreCase = true) ->
                        holder.registerProblem(
                            node,
                            "[CODE_PARTITION_OVERWRITE_001] Static partition overwrite mode will replace all partitions. " +
                                "Set spark.sql.sources.partitionOverwriteMode=dynamic to overwrite only the affected partitions.",
                            ProblemHighlightType.WARNING
                        )
                    key.startsWith("spark.") && key.contains("shuffle.partitions") ->
                        holder.registerProblem(
                            node,
                            "[CODE_SHUFFLE_PARTITIONS_001] Manually setting shuffle partitions — with AQE enabled Spark auto-tunes this value. Verify AQE is on before fixing this.",
                            ProblemHighlightType.WEAK_WARNING
                        )
                }
            }
        }
}
