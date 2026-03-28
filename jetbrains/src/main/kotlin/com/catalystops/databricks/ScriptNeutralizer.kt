package com.catalystops.databricks

/**
 * Neutralizes a PySpark script so it produces explain() output without
 * actually writing or collecting data. Ported from vscode/commands/analyzeCost.ts.
 */
object ScriptNeutralizer {

    fun neutralize(code: String): String {
        val lines = code.lines().toMutableList()
        val outputLines = mutableListOf<String>()
        var resultIndex = 0

        for (line in lines) {
            val neutralized = neutralizeLine(line, resultIndex)
            if (neutralized != null) {
                outputLines.add(neutralized.first)
                if (neutralized.second) resultIndex++
            } else {
                outputLines.add(line)
            }
        }

        // Add a capture block at the end for any remaining DataFrames
        outputLines.add("")
        outputLines.add("# CatalystOps: results collected above")

        return outputLines.joinToString("\n")
    }

    /**
     * Returns (replacedLine, didCapture) or null if no replacement was made.
     */
    private fun neutralizeLine(line: String, index: Int): Pair<String, Boolean>? {
        val trimmed = line.trim()
        val indent = line.length - line.trimStart().length
        val spaces = " ".repeat(indent)

        // Replace .write chains: df.write.parquet(...) / df.write.format(...).save(...) etc.
        if (Regex("""\.write\b""").containsMatchIn(trimmed)) {
            // Find the DataFrame expression before .write
            val dfExpr = extractDfBeforeWrite(trimmed)
            if (dfExpr != null) {
                val varName = "_catalystops_result_$index"
                return Pair(
                    "${spaces}$varName = $dfExpr\n${spaces}$varName.explain(\"formatted\")",
                    true
                )
            }
        }

        // Replace .show() calls
        if (Regex("""\.show\s*\(""").containsMatchIn(trimmed)) {
            val dfExpr = extractDfBeforeMethod(trimmed, "show")
            if (dfExpr != null) {
                val varName = "_catalystops_result_$index"
                return Pair(
                    "${spaces}$varName = $dfExpr\n${spaces}$varName.explain(\"formatted\")",
                    true
                )
            }
        }

        // Replace .collect() calls
        if (Regex("""\.collect\s*\(""").containsMatchIn(trimmed)) {
            val dfExpr = extractDfBeforeMethod(trimmed, "collect")
            if (dfExpr != null) {
                val varName = "_catalystops_result_$index"
                return Pair(
                    "${spaces}$varName = $dfExpr\n${spaces}$varName.explain(\"formatted\")",
                    true
                )
            }
        }

        // Replace .count() calls (standalone, not in comparisons for correctness)
        if (Regex("""\.count\s*\(\s*\)\s*$""").containsMatchIn(trimmed)) {
            val dfExpr = extractDfBeforeMethod(trimmed, "count")
            if (dfExpr != null) {
                val varName = "_catalystops_result_$index"
                return Pair(
                    "${spaces}$varName = $dfExpr\n${spaces}$varName.explain(\"formatted\")",
                    true
                )
            }
        }

        // Replace display(df) calls
        val displayMatch = Regex("""^\s*display\s*\(([^)]+)\)\s*$""").find(line)
        if (displayMatch != null) {
            val dfExpr = displayMatch.groupValues[1].trim()
            val varName = "_catalystops_result_$index"
            return Pair(
                "${spaces}$varName = $dfExpr\n${spaces}$varName.explain(\"formatted\")",
                true
            )
        }

        return null
    }

    /**
     * Extract the DataFrame expression before a .write chain.
     * e.g. "df.write.parquet('path')" → "df"
     * e.g. "result.write.format('delta').save('path')" → "result"
     */
    private fun extractDfBeforeWrite(trimmed: String): String? {
        val match = Regex("""^([a-zA-Z_][a-zA-Z0-9_.]*)\.write\b""").find(trimmed)
        return match?.groupValues?.get(1)
    }

    /**
     * Extract the DataFrame expression before a method call.
     * e.g. "df.show()" → "df"
     * e.g. "result.filter(...).show(10)" → "result.filter(...)"
     */
    private fun extractDfBeforeMethod(trimmed: String, method: String): String? {
        val pattern = Regex("""^(.*?)\.${Regex.escape(method)}\s*\(.*$""")
        val match = pattern.find(trimmed) ?: return null
        val dfExpr = match.groupValues[1].trim()
        if (dfExpr.isEmpty()) return null
        return dfExpr
    }
}
