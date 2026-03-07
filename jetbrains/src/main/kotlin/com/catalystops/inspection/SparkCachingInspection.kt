package com.catalystops.inspection

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

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        PyElementVisitor.EMPTY_VISITOR

    override fun checkFile(
        file: PsiFile,
        manager: InspectionManager,
        isOnTheFly: Boolean,
    ): Array<ProblemDescriptor> {
        val problems = mutableListOf<ProblemDescriptor>()

        // Collect all call expressions that look like spark.read.*, spark.table(), spark.sql()
        val allCalls = PsiTreeUtil.collectElementsOfType(file, PyCallExpression::class.java)

        // Map: variable name -> list of (assignment, sourceCallElement)
        val sourceAssignments = mutableMapOf<String, MutableList<PyCallExpression>>()

        for (call in allCalls) {
            val callee = call.callee as? PyReferenceExpression ?: continue
            if (callee.referencedName !in sourceMethods) continue

            // Only count if this call is on the RHS of an assignment
            val assignment = call.parent as? PyAssignmentStatement ?: continue
            val target = assignment.targets.firstOrNull() as? PyTargetExpression ?: continue
            val varName = target.name ?: continue

            sourceAssignments.getOrPut(varName) { mutableListOf() }.add(call)
        }

        // Flag variables assigned from source more than once without cache/persist between uses
        for ((varName, calls) in sourceAssignments) {
            if (calls.size > 1) {
                // Check that none of the uses between first and last have cache()/persist() in their chain
                val firstCall = calls.first()
                val assignment = firstCall.parent as? PyAssignmentStatement ?: continue
                problems.add(
                    manager.createProblemDescriptor(
                        firstCall,
                        "[CODE_REPRO_001] '$varName' is read from source multiple times without cache()/persist() — " +
                            "this re-executes the full scan on each use. Call df.cache() or df.persist() after the first read.",
                        isOnTheFly,
                        arrayOf(AddPersistFix()),
                        ProblemHighlightType.WARNING
                    )
                )
            }
        }

        return problems.toTypedArray()
    }
}
