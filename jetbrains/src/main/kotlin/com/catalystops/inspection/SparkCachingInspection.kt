package com.catalystops.inspection

import com.catalystops.quickfix.AddCacheFix
import com.catalystops.quickfix.AddPersistFix
import com.intellij.codeInspection.InspectionManager
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.PsiFile
import com.intellij.psi.util.PsiTreeUtil
import com.jetbrains.python.psi.PyAssignmentStatement
import com.jetbrains.python.psi.PyCallExpression
import com.jetbrains.python.psi.PyElementVisitor
import com.jetbrains.python.psi.PyReferenceExpression
import com.jetbrains.python.psi.PyTargetExpression

class SparkCachingInspection : LocalInspectionTool() {

    // Source-reading method names that produce a new DataFrame without cache
    private val sourceMethods = setOf("read", "table", "sql", "load", "readStream")
    private val actionMethods = setOf("count", "show", "collect", "take", "first")

    override fun getStaticDescription(): String = """
        <html>
        <body>
        <p><b>CatalystOps — PySpark Caching Inspection</b></p>
        <p>Detects situations where DataFrames are read or computed multiple times without caching, causing
        redundant scans and computation.</p>

        <h3>CODE_REPRO_001 — Repeated source scans</h3>
        <p>A DataFrame variable is assigned from a source (read, table, sql) more than once without
        cache()/persist() between uses, causing the full scan to re-execute on each use.</p>
        <pre>
# Instead of:
df = spark.read.parquet("path/")
result1 = df.filter(col("a") > 1)
result2 = df.groupBy("b").count()  # re-scans path/

# Use:
df = spark.read.parquet("path/").cache()
result1 = df.filter(col("a") > 1)
result2 = df.groupBy("b").count()
        </pre>

        <h3>CODE_REPEATED_ACTIONS_001 — Multiple actions without cache</h3>
        <p>Multiple Spark actions (count, show, collect, take, first) called on the same DataFrame variable
        recompute the entire pipeline each time. Add .cache() or .persist() before the first action.</p>
        <pre>
# Instead of:
total = df.count()
sample = df.show()

# Use:
df = df.cache()
total = df.count()
sample = df.show()
        </pre>
        </body>
        </html>
    """.trimIndent()

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        PyElementVisitor.EMPTY_VISITOR

    override fun checkFile(
        file: PsiFile,
        manager: InspectionManager,
        isOnTheFly: Boolean,
    ): Array<ProblemDescriptor> {
        val problems = mutableListOf<ProblemDescriptor>()

        // Collect all call expressions
        val allCalls = PsiTreeUtil.collectElementsOfType(file, PyCallExpression::class.java)

        // --- CODE_REPRO_001: variable assigned from source multiple times ---
        val sourceAssignments = mutableMapOf<String, MutableList<PyCallExpression>>()

        for (call in allCalls) {
            val callee = call.callee as? PyReferenceExpression ?: continue
            if (callee.referencedName !in sourceMethods) continue

            val assignment = call.parent as? PyAssignmentStatement ?: continue
            val target = assignment.targets.firstOrNull() as? PyTargetExpression ?: continue
            val varName = target.name ?: continue

            sourceAssignments.getOrPut(varName) { mutableListOf() }.add(call)
        }

        for ((_, calls) in sourceAssignments) {
            if (calls.size > 1) {
                val firstCall = calls.first()
                problems.add(
                    manager.createProblemDescriptor(
                        firstCall,
                        "[CODE_REPRO_001] DataFrame is read from source multiple times without cache()/persist() — " +
                            "this re-executes the full scan on each use. Call df.cache() or df.persist() after the first read.",
                        isOnTheFly,
                        arrayOf(AddPersistFix()),
                        ProblemHighlightType.WARNING
                    )
                )
            }
        }

        // --- CODE_REPEATED_ACTIONS_001: multiple actions on same var without intervening cache ---
        // Build a map of variable name -> list of action call positions
        // We scan calls in order and track per variable

        // Gather all assignments: varName -> first assignment call expression (to report on)
        val assignmentElement = mutableMapOf<String, PyCallExpression>()
        val actionCalls = mutableMapOf<String, MutableList<PyCallExpression>>()
        val cachedVars = mutableSetOf<String>()

        // Collect assignments to DataFrame vars (any assignment whose RHS is a call chain)
        for (call in allCalls) {
            val callee = call.callee as? PyReferenceExpression ?: continue
            val name = callee.referencedName ?: continue

            // Track cache/persist calls on known vars
            if (name == "cache" || name == "persist") {
                val qualifier = callee.qualifier
                if (qualifier is PyReferenceExpression) {
                    cachedVars.add(qualifier.referencedName ?: continue)
                }
                // Also handle: df = df.cache()
                val assignment = call.parent as? PyAssignmentStatement ?: continue
                val target = assignment.targets.firstOrNull() as? PyTargetExpression ?: continue
                cachedVars.add(target.name ?: continue)
            }

            // Track action calls on a qualifier variable
            if (name in actionMethods) {
                val qualifier = callee.qualifier
                if (qualifier is PyReferenceExpression) {
                    val varName = qualifier.referencedName ?: continue
                    actionCalls.getOrPut(varName) { mutableListOf() }.add(call)
                }
            }
        }

        // Collect assignment elements for each variable
        for (call in allCalls) {
            val assignment = call.parent as? PyAssignmentStatement ?: continue
            val target = assignment.targets.firstOrNull() as? PyTargetExpression ?: continue
            val varName = target.name ?: continue
            if (!assignmentElement.containsKey(varName)) {
                assignmentElement[varName] = call
            }
        }

        for ((varName, actions) in actionCalls) {
            if (actions.size > 1 && varName !in cachedVars) {
                val firstAction = actions.first()
                problems.add(
                    manager.createProblemDescriptor(
                        firstAction,
                        "[CODE_REPEATED_ACTIONS_001] Multiple actions on '$varName' recompute the entire pipeline each time. Add .cache() or .persist() before the first action.",
                        isOnTheFly,
                        arrayOf(AddCacheFix()),
                        ProblemHighlightType.WARNING
                    )
                )
            }
        }

        return problems.toTypedArray()
    }
}
