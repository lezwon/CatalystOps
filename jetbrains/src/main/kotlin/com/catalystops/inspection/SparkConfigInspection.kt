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

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — Spark Configuration Inspection</b></p>
        <p>Detects Spark configuration settings that degrade performance or cause correctness issues.</p>

        <h3>CODE_AQE_001 — AQE explicitly disabled</h3>
        <p>Adaptive Query Execution (AQE) dynamically optimises query plans at runtime (auto-tunes shuffle
        partitions, handles skew, etc.). It should remain enabled.</p>
        <pre>
# Instead of:
spark.conf.set("spark.sql.adaptive.enabled", "false")

# Remove this line or enable AQE:
spark.conf.set("spark.sql.adaptive.enabled", "true")
        </pre>

        <h3>CODE_PARTITION_OVERWRITE_001 — Static partition overwrite</h3>
        <p>Static partition overwrite mode replaces ALL partitions, even those not written to. Set to
        dynamic to overwrite only the affected partitions.</p>
        <pre>
spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")
        </pre>

        <h3>CODE_SHUFFLE_PARTITIONS_001 — Manual shuffle partition count</h3>
        <p>With AQE enabled, Spark auto-tunes shuffle partition count. Manually setting it may override
        AQE's optimisation. Verify AQE is enabled before tuning this.</p>
        </body>
        </html>
    """.trimIndent()

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
