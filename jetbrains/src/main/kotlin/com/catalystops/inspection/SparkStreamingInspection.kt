package com.catalystops.inspection

import com.catalystops.quickfix.AddWatermarkFix
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
import com.jetbrains.python.psi.PyKeywordArgument
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyStringLiteralExpression

class SparkStreamingInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Structured Streaming Inspection</b></p>
        <p>Detects common Structured Streaming anti-patterns that cause state bloat, data loss, or instability.</p>

        <h3>CODE_STREAM_QUERY_NAME_001 — Missing queryName()</h3>
        <p>Always set a query name on streaming queries for observability and management.</p>
        <pre>
df.writeStream.queryName("my_query").start()
        </pre>

        <h3>CODE_STREAM_TRIGGER_001 — trigger(once=True) deprecated</h3>
        <p>Use trigger(availableNow=True) for incremental batch processing instead.</p>

        <h3>CODE_STREAM_WATERMARK_001 — Kafka without watermark</h3>
        <p>Define a watermark to bound state size and enable late-data handling.</p>

        <h3>CODE_STREAMING_WATERMARK_001 — groupBy without withWatermark</h3>
        <p>groupBy() on a streaming DataFrame without withWatermark() causes unbounded state accumulation.</p>
        <pre>
# Instead of:
df.groupBy("user_id").count()

# Use:
df.withWatermark("event_time", "10 minutes").groupBy("user_id").count()
        </pre>

        <h3>CODE_STREAMING_INNER_JOIN_001 — Streaming inner join</h3>
        <p>Streaming inner join silently drops events that arrive after the watermark threshold.</p>

        <h3>CODE_DYNAMIC_ALLOC_001 — Dynamic allocation on streaming cluster</h3>
        <p>Dynamic allocation on a streaming cluster causes executor loss and instability. Disable it for streaming jobs.</p>

        <h3>CODE_AUTOLOADER_RATE_001 — Auto Loader without rate limit</h3>
        <p>Auto Loader without maxBytesPerTrigger ingests at unbounded rate and can overwhelm downstream systems.</p>
        <pre>
df = spark.readStream.format("cloudFiles") \
    .option("cloudFiles.format", "json") \
    .option("maxBytesPerTrigger", "100m") \
    .load(path)
        </pre>

        <h3>CODE_CHECKPOINT_DBFS_001 — Checkpoint on DBFS</h3>
        <p>Checkpoint stored on DBFS is unreliable for production streaming. Use cloud storage instead.</p>
        <pre>
# Instead of:
.option("checkpointLocation", "dbfs:/checkpoints/...")

# Use:
.option("checkpointLocation", "s3://my-bucket/checkpoints/...")
        </pre>

        <h3>CODE_KAFKA_COMMIT_001 — Kafka auto-commit enabled</h3>
        <p>Kafka auto-commit can cause data loss or duplication with Spark Streaming. Let Spark manage offsets.</p>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "writeStream" -> {
                        if (!forwardChainContains(node, "queryName")) {
                            holder.registerProblem(
                                node,
                                "[CODE_STREAM_QUERY_NAME_001] Streaming query missing .queryName() — always set a query name for observability and management.",
                                ProblemHighlightType.WARNING
                            )
                        }
                    }
                    "trigger" -> {
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
                        val args = node.argumentList?.arguments ?: return
                        // Kafka watermark check
                        if (args.any { it is PyStringLiteralExpression && it.stringValue.startsWith("kafka.") }) {
                            if (!backwardChainContains(callee.qualifier, "withWatermark")) {
                                holder.registerProblem(
                                    node,
                                    "[CODE_STREAM_WATERMARK_001] Kafka streaming source detected without withWatermark() — define a watermark to bound state size and enable late-data handling.",
                                    ProblemHighlightType.WARNING
                                )
                            }
                        }
                        // Checkpoint on DBFS
                        val optionKey = (args.getOrNull(0) as? PyStringLiteralExpression)?.stringValue
                        val optionValue = (args.getOrNull(1) as? PyStringLiteralExpression)?.stringValue
                        if (optionKey == "checkpointLocation" && optionValue != null && optionValue.startsWith("dbfs:/")) {
                            holder.registerProblem(
                                node,
                                "[CODE_CHECKPOINT_DBFS_001] Checkpoint stored on DBFS is unreliable for production streaming. Use cloud storage (s3://, abfss://, gs://) instead.",
                                ProblemHighlightType.WARNING
                            )
                        }
                        // Kafka auto-commit
                        if (optionKey == "kafka.enable.auto.commit" && optionValue?.equals("true", ignoreCase = true) == true) {
                            holder.registerProblem(
                                node,
                                "[CODE_KAFKA_COMMIT_001] Kafka auto-commit enabled can cause data loss or duplication with Spark Streaming. Let Spark manage offsets instead.",
                                ProblemHighlightType.ERROR
                            )
                        }
                    }
                }
            }

            private fun forwardChainContains(start: PyCallExpression, methodName: String): Boolean {
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

    override fun checkFile(
        file: PsiFile,
        manager: InspectionManager,
        isOnTheFly: Boolean,
    ): Array<ProblemDescriptor> {
        val problems = mutableListOf<ProblemDescriptor>()
        val text = file.text ?: return emptyArray()

        // Only apply streaming-specific file-level checks if file uses readStream
        val isStreamingFile = text.contains("readStream")
        if (!isStreamingFile) return emptyArray()

        val allCalls = PsiTreeUtil.collectElementsOfType(file, PyCallExpression::class.java)
        val hasWatermark = text.contains(".withWatermark(")

        for (call in allCalls) {
            val callee = call.callee as? PyReferenceExpression ?: continue
            when (callee.referencedName) {
                // CODE_STREAMING_WATERMARK_001: groupBy on streaming without withWatermark anywhere in file
                "groupBy" -> {
                    if (!hasWatermark) {
                        problems.add(
                            manager.createProblemDescriptor(
                                call,
                                "[CODE_STREAMING_WATERMARK_001] groupBy() on a streaming DataFrame without withWatermark() causes unbounded state accumulation.",
                                isOnTheFly,
                                arrayOf(AddWatermarkFix()),
                                ProblemHighlightType.WARNING
                            )
                        )
                    }
                }
                // CODE_STREAMING_INNER_JOIN_001: join in streaming file
                "join" -> {
                    problems.add(
                        manager.createProblemDescriptor(
                            call,
                            "[CODE_STREAMING_INNER_JOIN_001] Streaming inner join silently drops events that arrive after the watermark threshold.",
                            isOnTheFly,
                            emptyArray(),
                            ProblemHighlightType.WARNING
                        )
                    )
                }
                // CODE_AUTOLOADER_RATE_001: cloudFiles format without maxBytesPerTrigger
                "format" -> {
                    val args = call.argumentList?.arguments
                    val formatArg = args?.firstOrNull() as? PyStringLiteralExpression
                    if (formatArg?.stringValue == "cloudFiles") {
                        if (!text.contains("maxBytesPerTrigger")) {
                            problems.add(
                                manager.createProblemDescriptor(
                                    call,
                                    "[CODE_AUTOLOADER_RATE_001] Auto Loader without maxBytesPerTrigger ingests at unbounded rate. Set a rate limit to avoid overwhelming downstream systems.",
                                    isOnTheFly,
                                    emptyArray(),
                                    ProblemHighlightType.WARNING
                                )
                            )
                        }
                    }
                }
            }
        }

        // CODE_DYNAMIC_ALLOC_001: dynamicAllocation.enabled=true in a streaming file
        val dynamicAllocRegex = Regex("""spark\.dynamicAllocation\.enabled['"]\s*,\s*['"]true""")
        if (dynamicAllocRegex.containsMatchIn(text)) {
            val match = dynamicAllocRegex.find(text)!!
            val element = file.findElementAt(match.range.first) ?: file.firstChild
            if (element != null) {
                problems.add(
                    manager.createProblemDescriptor(
                        element,
                        "[CODE_DYNAMIC_ALLOC_001] Dynamic allocation on a streaming cluster causes executor loss and instability. Disable it for streaming jobs.",
                        isOnTheFly,
                        emptyArray(),
                        ProblemHighlightType.WARNING
                    )
                )
            }
        }

        return problems.toTypedArray()
    }
}
