package com.catalystops.telemetry

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lightweight Azure Application Insights telemetry client.
 *
 * Set [connectionString] before calling [track] — typically done once in PluginStartupActivity.
 * Connection string format:
 *   InstrumentationKey=<key>;IngestionEndpoint=https://<region>.applicationinsights.azure.com/
 *
 * Telemetry is silently dropped if the connection string is not configured,
 * or if sending fails for any reason — telemetry must never affect plugin stability.
 */
object TelemetryService {

    // -----------------------------------------------------------------------
    // Configuration — set once at plugin startup
    // -----------------------------------------------------------------------

    /** Full App Insights connection string. Leave blank to disable telemetry. */
    var connectionString: String = ""
        set(value) {
            field = value
            parseConnectionString(value)
        }

    private var iKey: String = ""
    private var endpoint: String = "https://dc.services.visualstudio.com"

    // -----------------------------------------------------------------------
    // Internal state
    // -----------------------------------------------------------------------

    private val initialized = AtomicBoolean(false)
    private val queue = ConcurrentLinkedQueue<TelemetryEvent>()
    private val http: HttpClient by lazy {
        HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build()
    }
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "catalystops-telemetry").also { it.isDaemon = true }
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    fun init(connStr: String) {
        if (!initialized.compareAndSet(false, true)) return
        connectionString = connStr
        scheduler.scheduleAtFixedRate(::flush, 60, 60, TimeUnit.SECONDS)
    }

    fun shutdown() {
        flush()
        scheduler.shutdown()
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    fun track(name: String, properties: Map<String, String> = emptyMap()) {
        if (iKey.isEmpty()) return
        queue.add(TelemetryEvent(name, properties))
        if (queue.size >= 20) scheduler.execute(::flush)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private fun parseConnectionString(connStr: String) {
        iKey = ""
        connStr.split(";").forEach { part ->
            val eq = part.indexOf('=')
            if (eq < 0) return@forEach
            val key = part.substring(0, eq).trim().lowercase()
            val value = part.substring(eq + 1).trim()
            when (key) {
                "instrumentationkey" -> iKey = value
                "ingestionendpoint"  -> endpoint = value.trimEnd('/')
            }
        }
    }

    private fun flush() {
        if (iKey.isEmpty() || queue.isEmpty()) return

        val batch = buildList {
            repeat(50) { queue.poll()?.let(::add) ?: return@buildList }
        }
        if (batch.isEmpty()) return

        val payload = batch.joinToString(",", "[", "]") { it.toJson(iKey) }
        try {
            val request = HttpRequest.newBuilder()
                .uri(URI.create("$endpoint/v2/track"))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build()
            http.sendAsync(request, HttpResponse.BodyHandlers.discarding())
                .exceptionally { null } // swallow errors silently
        } catch (_: Exception) {
            // Telemetry must never crash the plugin
        }
    }
}
