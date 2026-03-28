package com.catalystops.databricks

import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

// ── Data classes ─────────────────────────────────────────────────────────────

data class CommandResult(val status: String, val results: String?)

data class JobSummary(val jobId: Long, val name: String)

data class RunState(
    val lifeCycleState: String,
    val resultState: String?,
    val stateMessage: String?
)

data class RunSummary(
    val runId: Long,
    val jobId: Long,
    val state: RunState,
    val startTimeMs: Long,
    val endTimeMs: Long?,
    val clusterId: String?
)

data class RunDetails(
    val runId: Long,
    val clusterId: String?,
    val state: RunState
)

data class DbfsFileInfo(val path: String, val fileSize: Long, val isDir: Boolean)

data class ClusterInfo(
    val clusterId: String,
    val clusterName: String,
    val state: String,
    val sparkVersion: String,
    val numWorkers: Int?,
    val driverNodeTypeId: String?
)

data class SqlWarehouseInfo(val id: String, val name: String, val state: String)

// ── Client ───────────────────────────────────────────────────────────────────

class DatabricksClient(private val host: String, private val token: String) {

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(15))
        .build()

    // ── Execution Context API (cluster mode) ─────────────────────────────────

    fun createContext(clusterId: String): String {
        val body = """{"language":"python","clusterId":"$clusterId"}"""
        val resp = post("/api/1.2/contexts/create", body)
        return extractJsonString(resp, "id")
            ?: throw RuntimeException("createContext: no id in response: $resp")
    }

    fun executeCommand(contextId: String, clusterId: String, code: String): String {
        val escapedCode = escapeJsonString(code)
        val body = """{"language":"python","contextId":"$contextId","clusterId":"$clusterId","command":"$escapedCode"}"""
        val resp = post("/api/1.2/commands/execute", body)
        return extractJsonString(resp, "id")
            ?: throw RuntimeException("executeCommand: no id in response: $resp")
    }

    fun getCommandStatus(contextId: String, clusterId: String, commandId: String): CommandResult {
        val path = "/api/1.2/commands/status?contextId=${enc(contextId)}&clusterId=${enc(clusterId)}&commandId=${enc(commandId)}"
        val resp = get(path)
        val status = extractJsonString(resp, "status") ?: "Unknown"
        // results.data field
        val resultsData = extractNestedJsonString(resp, "results", "data")
        return CommandResult(status, resultsData)
    }

    fun destroyContext(contextId: String, clusterId: String) {
        val body = """{"contextId":"$contextId","clusterId":"$clusterId"}"""
        post("/api/1.2/contexts/destroy", body)
    }

    // ── Serverless / Jobs API ────────────────────────────────────────────────

    fun submitServerlessRun(@Suppress("UNUSED_PARAMETER") code: String): Long {
        val body = """{"tasks":[{"task_key":"catalystops_dryrun","spark_python_task":{"python_file":"dbfs:/tmp/catalystops_tmp.py"}}],"new_cluster":{"spark_version":"13.3.x-scala2.12","node_type_id":"i3.xlarge","num_workers":1}}"""
        // For a real serverless submit, the script must be pre-uploaded.
        // This method accepts raw code for simplicity — caller is responsible for upload.
        val resp = post("/api/2.0/jobs/runs/submit", body)
        return extractJsonLong(resp, "run_id")
            ?: throw RuntimeException("submitServerlessRun: no run_id in response: $resp")
    }

    fun getRunStatus(runId: Long): RunSummary {
        val resp = get("/api/2.1/jobs/runs/get?run_id=$runId")
        return parseRunSummary(resp)
    }

    fun cancelRun(runId: Long) {
        post("/api/2.0/jobs/runs/cancel", """{"run_id":$runId}""")
    }

    // ── Jobs listing ─────────────────────────────────────────────────────────

    fun listJobs(): List<JobSummary> {
        val resp = get("/api/2.1/jobs/list?limit=25&expand_tasks=false")
        return parseJobsList(resp)
    }

    fun getLastRun(jobId: Long): RunSummary? {
        val resp = get("/api/2.1/jobs/runs/list?job_id=$jobId&limit=1&active_only=false")
        return parseFirstRun(resp)
    }

    fun getRunDetails(runId: Long): RunDetails {
        val resp = get("/api/2.1/jobs/runs/get?run_id=$runId")
        val run = parseRunSummary(resp)
        return RunDetails(run.runId, run.clusterId, run.state)
    }

    fun getClusterEventLogPath(clusterId: String): String? {
        return try {
            val resp = get("/api/2.0/clusters/get?cluster_id=${enc(clusterId)}")
            // Try to extract cluster_log_conf.dbfs.destination
            val dest = extractDeepJsonString(resp, "cluster_log_conf", "dbfs", "destination")
            if (dest != null) {
                "${dest.trimEnd('/')}/$clusterId/eventlog"
            } else {
                "dbfs:/cluster-logs/$clusterId/eventlog"
            }
        } catch (_: Exception) {
            "dbfs:/cluster-logs/$clusterId/eventlog"
        }
    }

    // ── DBFS API ─────────────────────────────────────────────────────────────

    fun listDbfs(path: String): List<DbfsFileInfo> {
        val resp = get("/api/2.0/dbfs/list?path=${enc(path)}")
        return parseDbfsFileList(resp)
    }

    fun readDbfsFile(path: String, offset: Long, length: Int): ByteArray {
        val resp = get("/api/2.0/dbfs/read?path=${enc(path)}&offset=$offset&length=$length")
        val data = extractJsonString(resp, "data") ?: return ByteArray(0)
        return java.util.Base64.getDecoder().decode(data)
    }

    // ── Clusters API ─────────────────────────────────────────────────────────

    fun listClusters(): List<ClusterInfo> {
        val resp = get("/api/2.0/clusters/list")
        return parseClustersList(resp)
    }

    fun startCluster(clusterId: String) {
        post("/api/2.0/clusters/start", """{"cluster_id":"$clusterId"}""")
    }

    fun terminateCluster(clusterId: String) {
        post("/api/2.0/clusters/delete", """{"cluster_id":"$clusterId"}""")
    }

    fun editCluster(clusterId: String, updates: Map<String, String>) {
        val kvPairs = updates.entries.joinToString(",") { (k, v) -> """"$k":"$v"""" }
        post("/api/2.0/clusters/edit", """{"cluster_id":"$clusterId",$kvPairs}""")
    }

    fun getClusterState(clusterId: String): String {
        val resp = get("/api/2.0/clusters/get?cluster_id=${enc(clusterId)}")
        return extractJsonString(resp, "state") ?: "UNKNOWN"
    }

    // ── SQL Warehouse / Billing API ───────────────────────────────────────────

    fun listWarehouses(): List<SqlWarehouseInfo> {
        val resp = get("/api/2.0/sql/warehouses")
        return parseWarehousesList(resp)
    }

    fun queryBilling(warehouseId: String, sql: String): List<Map<String, String>> {
        val escapedSql = escapeJsonString(sql)
        val body = """{"warehouse_id":"$warehouseId","statement":"$escapedSql","wait_timeout":"60s"}"""
        val resp = post("/api/2.0/sql/statements", body)
        return parseSqlResults(resp)
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    private fun get(path: String): String {
        val request = HttpRequest.newBuilder()
            .uri(URI.create("$host$path"))
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .timeout(Duration.ofSeconds(30))
            .GET()
            .build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            throw RuntimeException("HTTP ${response.statusCode()} for GET $path: ${response.body().take(300)}")
        }
        return response.body()
    }

    private fun post(path: String, body: String): String {
        val request = HttpRequest.newBuilder()
            .uri(URI.create("$host$path"))
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .timeout(Duration.ofSeconds(30))
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            throw RuntimeException("HTTP ${response.statusCode()} for POST $path: ${response.body().take(300)}")
        }
        return response.body()
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    // ── Minimal JSON parsing ──────────────────────────────────────────────────
    // We use simple regex-based extraction to avoid external dependencies.

    private fun extractJsonString(json: String, key: String): String? {
        val pattern = Regex(""""${Regex.escape(key)}"\s*:\s*"((?:[^"\\]|\\.)*)"""")
        return pattern.find(json)?.groupValues?.get(1)?.unescapeJson()
    }

    private fun extractJsonLong(json: String, key: String): Long? {
        val pattern = Regex(""""${Regex.escape(key)}"\s*:\s*(\d+)""")
        return pattern.find(json)?.groupValues?.get(1)?.toLongOrNull()
    }

    private fun extractNestedJsonString(json: String, outerKey: String, innerKey: String): String? {
        // Find the outer object value, then extract the inner key from it
        val outerPattern = Regex(""""${Regex.escape(outerKey)}"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}""")
        val outerMatch = outerPattern.find(json) ?: return null
        return extractJsonString("{${outerMatch.groupValues[1]}}", innerKey)
    }

    private fun extractDeepJsonString(json: String, vararg keys: String): String? {
        var current = json
        for (key in keys.dropLast(1)) {
            val pattern = Regex(""""${Regex.escape(key)}"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}""")
            val match = pattern.find(current) ?: return null
            current = "{${match.groupValues[1]}}"
        }
        return extractJsonString(current, keys.last())
    }

    private fun parseRunSummary(json: String): RunSummary {
        val runId = extractJsonLong(json, "run_id") ?: 0L
        val jobId = extractJsonLong(json, "job_id") ?: 0L
        val lifeCycle = extractNestedJsonString(json, "state", "life_cycle_state") ?: "PENDING"
        val resultState = extractNestedJsonString(json, "state", "result_state")
        val stateMsg = extractNestedJsonString(json, "state", "state_message")
        val startTime = extractJsonLong(json, "start_time") ?: 0L
        val endTime = extractJsonLong(json, "end_time")?.takeIf { it > 0 }
        // cluster_id may appear in cluster_instance or cluster_spec
        val clusterId = extractNestedJsonString(json, "cluster_instance", "cluster_id")
            ?: extractJsonString(json, "existing_cluster_id")
        return RunSummary(
            runId = runId,
            jobId = jobId,
            state = RunState(lifeCycle, resultState, stateMsg),
            startTimeMs = startTime,
            endTimeMs = endTime,
            clusterId = clusterId
        )
    }

    private fun parseJobsList(json: String): List<JobSummary> {
        val results = mutableListOf<JobSummary>()
        // Parse "jobs":[{...},{...}] array entries
        val arrayPattern = Regex(""""jobs"\s*:\s*\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]""")
        val arrayMatch = arrayPattern.find(json) ?: return results
        val arrayContent = arrayMatch.groupValues[1]
        // Split by job objects — find each {...} at top level
        val jobPattern = Regex("""\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}""")
        for (jobMatch in jobPattern.findAll(arrayContent)) {
            val jobJson = jobMatch.value
            val jobId = extractJsonLong(jobJson, "job_id") ?: continue
            // name is nested under settings.name
            val name = extractNestedJsonString(jobJson, "settings", "name")
                ?: "Job $jobId"
            results.add(JobSummary(jobId, name))
        }
        return results
    }

    private fun parseFirstRun(json: String): RunSummary? {
        // Find "runs":[{...}] and parse the first object
        val arrayPattern = Regex(""""runs"\s*:\s*\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]""")
        val arrayMatch = arrayPattern.find(json) ?: return null
        val arrayContent = arrayMatch.groupValues[1].trim()
        if (arrayContent.isEmpty()) return null
        val firstObj = Regex("""\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}""").find(arrayContent) ?: return null
        return parseRunSummary(firstObj.value)
    }

    private fun parseDbfsFileList(json: String): List<DbfsFileInfo> {
        val results = mutableListOf<DbfsFileInfo>()
        val arrayPattern = Regex(""""files"\s*:\s*\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]""")
        val arrayMatch = arrayPattern.find(json) ?: return results
        val arrayContent = arrayMatch.groupValues[1]
        val filePattern = Regex("""\{[^{}]*\}""")
        for (fileMatch in filePattern.findAll(arrayContent)) {
            val fileJson = fileMatch.value
            val path = extractJsonString(fileJson, "path") ?: continue
            val fileSize = extractJsonLong(fileJson, "file_size") ?: 0L
            val isDir = fileJson.contains(""""is_dir"\s*:\s*true""".toRegex())
            results.add(DbfsFileInfo(path, fileSize, isDir))
        }
        return results
    }

    private fun parseClustersList(json: String): List<ClusterInfo> {
        val results = mutableListOf<ClusterInfo>()
        val arrayPattern = Regex(""""clusters"\s*:\s*\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]""")
        val arrayMatch = arrayPattern.find(json) ?: return results
        val arrayContent = arrayMatch.groupValues[1]
        val objPattern = Regex("""\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}""")
        for (m in objPattern.findAll(arrayContent)) {
            val obj = m.value
            val clusterId = extractJsonString(obj, "cluster_id") ?: continue
            val clusterName = extractJsonString(obj, "cluster_name") ?: clusterId
            val state = extractJsonString(obj, "state") ?: "UNKNOWN"
            val sparkVersion = extractJsonString(obj, "spark_version") ?: ""
            val numWorkers = extractJsonLong(obj, "num_workers")?.toInt()
            val driverNodeTypeId = extractJsonString(obj, "driver_node_type_id")
            results.add(ClusterInfo(clusterId, clusterName, state, sparkVersion, numWorkers, driverNodeTypeId))
        }
        return results
    }

    private fun parseWarehousesList(json: String): List<SqlWarehouseInfo> {
        val results = mutableListOf<SqlWarehouseInfo>()
        val arrayPattern = Regex(""""warehouses"\s*:\s*\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]""")
        val arrayMatch = arrayPattern.find(json) ?: return results
        val arrayContent = arrayMatch.groupValues[1]
        val objPattern = Regex("""\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}""")
        for (m in objPattern.findAll(arrayContent)) {
            val obj = m.value
            val id = extractJsonString(obj, "id") ?: continue
            val name = extractJsonString(obj, "name") ?: id
            val state = extractJsonString(obj, "state") ?: "UNKNOWN"
            results.add(SqlWarehouseInfo(id, name, state))
        }
        return results
    }

    private fun parseSqlResults(json: String): List<Map<String, String>> {
        val rows = mutableListOf<Map<String, String>>()
        // Extract column names from schema
        val schemaPattern = Regex(""""columns"\s*:\s*\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]""")
        val schemaMatch = schemaPattern.find(json) ?: return rows
        val colNames = mutableListOf<String>()
        val namePattern = Regex(""""name"\s*:\s*"([^"\\]*)"""")
        for (nm in namePattern.findAll(schemaMatch.groupValues[1])) {
            colNames.add(nm.groupValues[1])
        }
        if (colNames.isEmpty()) return rows

        // Extract data rows — each row is an array of values
        val dataArrayPattern = Regex(""""data_array"\s*:\s*\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]""")
        val dataMatch = dataArrayPattern.find(json) ?: return rows
        // Split individual row arrays
        val rowPattern = Regex("""\[([^\[\]]*)\]""")
        for (rowMatch in rowPattern.findAll(dataMatch.groupValues[1])) {
            val cells = rowMatch.groupValues[1].split(",").map { it.trim().trim('"') }
            val rowMap = mutableMapOf<String, String>()
            colNames.forEachIndexed { i, name -> rowMap[name] = cells.getOrElse(i) { "" } }
            rows.add(rowMap)
        }
        return rows
    }

    private fun escapeJsonString(s: String): String =
        s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")

    private fun String.unescapeJson(): String =
        replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
}
