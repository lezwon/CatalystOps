package com.catalystops.databricks

/**
 * Fetches Spark physical plans from a Databricks DBFS event log.
 * Ported from vscode/databricks/eventLogParser.ts.
 */

data class SparkPlanEntry(
    val executionId: Long,
    val description: String,
    val physicalPlan: String
)

object EventLogFetcher {

    private const val MAX_BYTES_TO_SCAN = 10L * 1024 * 1024  // 10 MB
    private const val CHUNK_SIZE = 256 * 1024                  // 256 KB

    fun fetchPlans(client: DatabricksClient, logPath: String): List<SparkPlanEntry> {
        val rawPath = resolveLogFile(client, logPath) ?: return emptyList()
        val filePath = if (rawPath.startsWith("/")) "dbfs:$rawPath" else rawPath

        val plans = mutableListOf<SparkPlanEntry>()
        var offset = 0L
        var remainder = ""
        val deadline = System.currentTimeMillis() + 45_000L

        while (System.currentTimeMillis() < deadline && offset < MAX_BYTES_TO_SCAN) {
            val length = minOf(CHUNK_SIZE.toLong(), MAX_BYTES_TO_SCAN - offset).toInt()
            val bytes = try {
                client.readDbfsFile(filePath, offset, length)
            } catch (_: Exception) {
                break
            }
            if (bytes.isEmpty()) break

            val chunk = String(bytes, Charsets.UTF_8)
            val text = remainder + chunk
            val lines = text.split("\n")
            remainder = lines.last()

            for (line in lines.dropLast(1)) {
                if (!line.contains("SparkListenerSQLExecutionStart")) continue
                try {
                    parsePlanEntry(line)?.let { plans.add(it) }
                } catch (_: Exception) { /* skip malformed lines */ }
            }

            offset += bytes.size
            if (bytes.size < length) break  // EOF
        }

        return plans
    }

    private fun parsePlanEntry(line: String): SparkPlanEntry? {
        if (!line.contains("org.apache.spark.sql.execution.ui.SparkListenerSQLExecutionStart")) return null
        // Extract executionId
        val execIdMatch = Regex(""""executionId"\s*:\s*(\d+)""").find(line) ?: return null
        val execId = execIdMatch.groupValues[1].toLongOrNull() ?: return null
        // Extract description
        val descMatch = Regex(""""description"\s*:\s*"((?:[^"\\]|\\.)*)"""").find(line)
        val description = descMatch?.groupValues?.get(1)?.unescapeJson() ?: ""
        // Extract physicalPlanDescription
        val planMatch = Regex(""""physicalPlanDescription"\s*:\s*"((?:[^"\\]|\\.)*)"""").find(line) ?: return null
        val physicalPlan = planMatch.groupValues[1].unescapeJson()
        if (physicalPlan.isEmpty()) return null
        return SparkPlanEntry(execId, description, physicalPlan)
    }

    /**
     * Recursively resolve a DBFS path to the actual event log file.
     * Databricks layout: {dest}/{clusterId}/eventlog/{appId}/{attemptId}/eventlog
     */
    private fun resolveLogFile(client: DatabricksClient, path: String, depth: Int = 0): String? {
        if (depth > 4) return null
        val entries = try {
            client.listDbfs(path)
        } catch (_: Exception) {
            // Not a listable directory — treat as file
            return path
        }

        val files = entries.filter { !it.isDir }.sortedByDescending { it.path }
        if (files.isNotEmpty()) return files.first().path

        val dirs = entries.filter { it.isDir }.sortedByDescending { it.path }
        for (dir in dirs) {
            val result = resolveLogFile(client, dir.path, depth + 1)
            if (result != null) return result
        }
        return null
    }

    private fun String.unescapeJson(): String =
        replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
}
