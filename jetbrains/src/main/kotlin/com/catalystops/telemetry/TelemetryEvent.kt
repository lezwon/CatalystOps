package com.catalystops.telemetry

import java.time.Instant
import java.time.format.DateTimeFormatter

data class TelemetryEvent(
    val name: String,
    val properties: Map<String, String> = emptyMap(),
    val time: String = DateTimeFormatter.ISO_INSTANT.format(Instant.now()),
)

internal fun TelemetryEvent.toJson(iKey: String): String {
    val propsJson = properties.entries.joinToString(",") { (k, v) ->
        "\"${k.escJson()}\":\"${v.escJson()}\""
    }
    return """{"name":"Microsoft.ApplicationInsights.$iKey.Event","time":"$time","iKey":"$iKey","data":{"baseType":"EventData","baseData":{"ver":2,"name":"${name.escJson()}","properties":{$propsJson}}}}"""
}

private fun String.escJson() = replace("\\", "\\\\").replace("\"", "\\\"")
