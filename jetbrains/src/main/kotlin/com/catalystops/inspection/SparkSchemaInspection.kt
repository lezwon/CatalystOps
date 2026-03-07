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

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor =
        object : PyElementVisitor() {
            override fun visitPyCallExpression(node: PyCallExpression) {
                super.visitPyCallExpression(node)
                val callee = node.callee as? PyReferenceExpression ?: return
                when (callee.referencedName) {
                    "csv", "json", "parquet", "orc", "load" -> {
                        // Flag inferSchema=True keyword argument
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
                        // Flag select("*") wildcard
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
                }
            }
        }
}
