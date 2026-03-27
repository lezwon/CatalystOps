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

class SparkSchemaInspection : LocalInspectionTool() {

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Schema Inspection</b></p>
        <p>Detects schema-related anti-patterns that cause unnecessary full scans or fragile pipelines.</p>

        <h3>CODE_SCHEMA_001 — inferSchema=True</h3>
        <p>inferSchema=True scans the entire dataset to infer types. For large files this doubles read time.
        Provide an explicit schema to avoid the schema inference scan.</p>
        <pre>
# Instead of:
df = spark.read.csv("path/", inferSchema=True)

# Use:
schema = StructType([StructField("id", IntegerType()), ...])
df = spark.read.schema(schema).csv("path/")
        </pre>

        <h3>CODE_SELECT_STAR_001 — select("*")</h3>
        <p>select("*") reads all columns. Specify only the columns you need to reduce shuffle and I/O.</p>
        <pre>
# Instead of:
df.select("*")

# Use:
df.select("id", "name", "value")
        </pre>

        <h3>CODE_READ_FILES_SCHEMA_001 — read_files() without schemaHints</h3>
        <p>read_files() without schemaHints infers schema on every run, which is slow and fragile.
        Add schemaHints= to pin the schema.</p>
        <pre>
# Instead of:
df = spark.read.format("read_files").load("path/")

# Use:
df = read_files("path/", schemaHints="id INT, name STRING, value DOUBLE")
        </pre>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "csv", "json", "parquet", "orc", "load" -> {
                        val args = node.argumentList?.arguments ?: return
                        for (arg in args) {
                            if (arg is PyKeywordArgument && arg.keyword == "inferSchema") {
                                val value = arg.valueExpression
                                if (value != null && value.text == "True") {
                                    holder.registerProblem(
                                        arg,
                                        "[CODE_SCHEMA_001] inferSchema=True scans the entire dataset to infer types — " +
                                            "provide an explicit schema for large files to avoid a full scan on read.",
                                        ProblemHighlightType.WARNING
                                    )
                                }
                            }
                        }
                    }
                    "select" -> {
                        val args = node.argumentList?.arguments ?: return
                        for (arg in args) {
                            if (arg is PyStringLiteralExpression && arg.stringValue == "*") {
                                holder.registerProblem(
                                    arg,
                                    "[CODE_SELECT_STAR_001] select(\"*\") reads all columns — specify only the columns you need to reduce shuffle and I/O.",
                                    ProblemHighlightType.WEAK_WARNING
                                )
                            }
                        }
                    }
                    "read_files" -> {
                        // CODE_READ_FILES_SCHEMA_001: read_files without schemaHints parameter
                        val args = node.argumentList?.arguments ?: return
                        val hasSchemaHints = args.any { arg ->
                            arg is PyKeywordArgument && arg.keyword == "schemaHints"
                        }
                        if (!hasSchemaHints) {
                            holder.registerProblem(
                                node,
                                "[CODE_READ_FILES_SCHEMA_001] read_files() without schemaHints infers schema on every run, which is slow and fragile. Add schemaHints= to pin the schema.",
                                ProblemHighlightType.INFORMATION
                            )
                        }
                    }
                }
            }
        }
}
