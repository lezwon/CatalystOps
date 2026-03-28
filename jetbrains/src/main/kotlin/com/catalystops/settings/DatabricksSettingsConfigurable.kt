package com.catalystops.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import javax.swing.JComponent
import javax.swing.SwingUtilities

class DatabricksSettingsConfigurable(private val project: Project) : Configurable {

    private var settingsPanel: DatabricksSettingsPanel? = null

    override fun getDisplayName(): String = "CatalystOps"

    override fun createComponent(): JComponent {
        val panel = DatabricksSettingsPanel()
        settingsPanel = panel

        panel.testConnectionButton.addActionListener {
            panel.testConnectionStatus.text = "Testing..."
            val host = normalizeHost(panel.hostField.text.trim())
            val token = String(panel.tokenField.password).trim()
            val clusterId = panel.clusterIdField.text.trim()

            if (host.isEmpty() || token.isEmpty()) {
                panel.testConnectionStatus.text = "Host and token are required."
                return@addActionListener
            }

            Thread {
                val result = testConnection(host, token, clusterId)
                SwingUtilities.invokeLater {
                    panel.testConnectionStatus.text = result
                }
            }.apply { isDaemon = true }.start()
        }

        reset()
        return panel.panel
    }

    override fun isModified(): Boolean {
        val p = settingsPanel ?: return false
        val state = DatabricksSettings.getInstance(project).state
        return p.hostField.text.trim() != state.host ||
            String(p.tokenField.password).trim() != state.token ||
            p.clusterIdField.text.trim() != state.clusterId ||
            p.getExecutionMode() != state.executionMode ||
            (p.timeoutField.text.trim().toIntOrNull() ?: 300) != state.timeoutSeconds ||
            p.warehouseIdField.text.trim() != state.warehouseId ||
            (p.dbuRateField.text.trim().toDoubleOrNull() ?: 0.4) != state.dbuRatePerHour ||
            (p.serverlessRateField.text.trim().toDoubleOrNull() ?: 0.7) != state.serverlessRatePerHour
    }

    override fun apply() {
        val p = settingsPanel ?: return
        val state = DatabricksSettings.getInstance(project).state
        state.host = normalizeHost(p.hostField.text.trim())
        state.token = String(p.tokenField.password).trim()
        state.clusterId = p.clusterIdField.text.trim()
        state.executionMode = p.getExecutionMode()
        state.timeoutSeconds = p.timeoutField.text.trim().toIntOrNull() ?: 300
        state.warehouseId = p.warehouseIdField.text.trim()
        state.dbuRatePerHour = p.dbuRateField.text.trim().toDoubleOrNull() ?: 0.4
        state.serverlessRatePerHour = p.serverlessRateField.text.trim().toDoubleOrNull() ?: 0.7
    }

    override fun reset() {
        val p = settingsPanel ?: return
        val state = DatabricksSettings.getInstance(project).state
        p.hostField.text = state.host
        p.tokenField.text = state.token
        p.clusterIdField.text = state.clusterId
        p.setExecutionMode(state.executionMode)
        p.timeoutField.text = state.timeoutSeconds.toString()
        p.warehouseIdField.text = state.warehouseId
        p.dbuRateField.text = state.dbuRatePerHour.toString()
        p.serverlessRateField.text = state.serverlessRatePerHour.toString()
    }

    private fun normalizeHost(host: String): String {
        if (host.isEmpty()) return host
        val h = host.trimEnd('/')
        return if (h.startsWith("https://") || h.startsWith("http://")) h else "https://$h"
    }

    private fun testConnection(host: String, token: String, clusterId: String): String {
        return try {
            val path = if (clusterId.isNotEmpty()) {
                "/api/2.0/clusters/get?cluster_id=${java.net.URLEncoder.encode(clusterId, "UTF-8")}"
            } else {
                "/api/2.0/clusters/list"
            }
            val client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build()
            val request = HttpRequest.newBuilder()
                .uri(URI.create("$host$path"))
                .header("Authorization", "Bearer $token")
                .timeout(Duration.ofSeconds(15))
                .GET()
                .build()
            val response = client.send(request, HttpResponse.BodyHandlers.ofString())
            when (response.statusCode()) {
                200 -> "OK — connected successfully."
                401, 403 -> "Authentication failed (${response.statusCode()}). Check your token."
                404 -> "Cluster not found or invalid host."
                else -> "Error: HTTP ${response.statusCode()}"
            }
        } catch (e: Exception) {
            "Connection failed: ${e.message}"
        }
    }
}
