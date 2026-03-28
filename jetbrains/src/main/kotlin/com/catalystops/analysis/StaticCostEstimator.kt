package com.catalystops.analysis

/**
 * Static Cost Estimator — ported from vscode/analysis/staticCostEstimator.ts
 *
 * Reads `# @compute: nodes=4, cores=2, memory=16GB, rate=0.25` and
 * `# @size: 50GB` annotations from Python source and computes an estimated cost.
 */

data class ComputeSpec(
    val nodes: Int,
    val cores: Int,
    val memoryGB: Double,
    val ratePerHour: Double,
    /** Multiplier applied to raw scan time to model full-notebook cost (default 2.0). */
    val overheadFactor: Double,
    /** 0-based line index of the @compute annotation */
    val annotationLine: Int
)

data class SizeAnnotation(
    val varName: String?,
    val sizeBytes: Long,
    val annotationLine: Int
)

data class StaticCostEstimate(
    val computeSpec: ComputeSpec,
    val annotations: List<SizeAnnotation>,
    val totalDataGB: Double,
    val formattedCost: String,
    val dollars: Double
)

object StaticCostEstimator {

    /**
     * Parse the `# @compute:` annotation from source code.
     * Returns null if absent or any required key is missing.
     */
    fun parseComputeSpec(code: String): ComputeSpec? {
        val matchResult = Regex("^#\\s*@compute:\\s*(.+)$", RegexOption.MULTILINE).find(code)
            ?: return null

        val kvStr = matchResult.groupValues[1]
        val pairs = mutableMapOf<String, String>()
        for (part in kvStr.split(",")) {
            val eq = part.indexOf('=')
            if (eq == -1) continue
            pairs[part.substring(0, eq).trim()] = part.substring(eq + 1).trim()
        }

        val nodes = pairs["nodes"]?.toIntOrNull() ?: return null
        val cores = pairs["cores"]?.toIntOrNull() ?: return null
        val memoryGB = parseMemoryGB(pairs["memory"] ?: return null) ?: return null
        val ratePerHour = pairs["rate"]?.toDoubleOrNull() ?: return null
        val overheadFactor = pairs["overhead"]?.toDoubleOrNull() ?: 2.0

        val annotationLine = code.substring(0, matchResult.range.first).count { it == '\n' }

        return ComputeSpec(nodes, cores, memoryGB, ratePerHour, overheadFactor, annotationLine)
    }

    private fun parseMemoryGB(memStr: String): Double? {
        val m = Regex("^(\\d+(?:\\.\\d+)?)\\s*(GB|MB|KB|TB)$", RegexOption.IGNORE_CASE).find(memStr.trim())
            ?: return null
        val value = m.groupValues[1].toDoubleOrNull() ?: return null
        return when (m.groupValues[2].uppercase()) {
            "TB" -> value * 1024.0
            "GB" -> value
            "MB" -> value / 1024.0
            "KB" -> value / (1024.0 * 1024.0)
            else -> null
        }
    }

    fun parseSizeBytes(sizeStr: String): Long {
        val m = Regex("^(\\d+(?:\\.\\d+)?)\\s*(GB|MB|KB|TB)$", RegexOption.IGNORE_CASE).find(sizeStr.trim())
            ?: return 0L
        val value = m.groupValues[1].toDoubleOrNull() ?: return 0L
        return when (m.groupValues[2].uppercase()) {
            "TB" -> (value * 1024.0 * 1024.0 * 1024.0 * 1024.0).toLong()
            "GB" -> (value * 1024.0 * 1024.0 * 1024.0).toLong()
            "MB" -> (value * 1024.0 * 1024.0).toLong()
            "KB" -> (value * 1024.0).toLong()
            else -> 0L
        }
    }

    fun parseSizeAnnotations(code: String): List<SizeAnnotation> {
        val lines = code.split("\n")
        val annotations = mutableListOf<SizeAnnotation>()
        val sizeRegex = Regex("#\\s*@size:\\s*(\\S+)")

        for (matchResult in sizeRegex.findAll(code)) {
            val sizeStr = matchResult.groupValues[1]
            val sizeBytes = parseSizeBytes(sizeStr)

            val annotationLine = code.substring(0, matchResult.range.first).count { it == '\n' }

            var varName: String? = null
            val sameLine = lines.getOrElse(annotationLine) { "" }
            val sameLineMatch = Regex("(\\w+)\\s*=").find(sameLine)
            if (sameLineMatch != null) {
                varName = sameLineMatch.groupValues[1]
            } else {
                val nextLine = lines.getOrElse(annotationLine + 1) { "" }
                val nextLineMatch = Regex("(\\w+)\\s*=").find(nextLine)
                if (nextLineMatch != null) {
                    varName = nextLineMatch.groupValues[1]
                }
            }

            annotations.add(SizeAnnotation(varName, sizeBytes, annotationLine))
        }

        return annotations
    }

    /**
     * Estimate dollar cost from static annotations.
     * Returns null if no `# @compute:` annotation is present.
     */
    fun estimateStaticCost(code: String): StaticCostEstimate? {
        if (!code.contains("@compute:")) return null

        val computeSpec = parseComputeSpec(code) ?: return null
        val annotations = parseSizeAnnotations(code)
        val totalBytes = annotations.sumOf { it.sizeBytes }
        val totalDataGB = totalBytes / (1024.0 * 1024.0 * 1024.0)

        // Estimate: totalGB / effective_throughput_per_hour * ratePerHour * overheadFactor
        // Throughput model: each node processes ~100 GB/hour in scans (conservative)
        val throughputGBPerHour = computeSpec.nodes * 100.0
        val scanHours = if (throughputGBPerHour > 0) totalDataGB / throughputGBPerHour else 0.0
        val dollars = scanHours * computeSpec.ratePerHour * computeSpec.nodes * computeSpec.overheadFactor

        val formattedCost = when {
            totalBytes == 0L -> "unknown"
            dollars < 0.0001 -> "<\$0.0001"
            else -> "~\$${String.format("%.4f", dollars)}"
        }

        return StaticCostEstimate(computeSpec, annotations, totalDataGB, formattedCost, dollars)
    }
}
