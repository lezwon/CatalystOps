package com.catalystops.toolwindow

import com.catalystops.databricks.DatabricksClient
import com.catalystops.settings.DatabricksSettings
import com.catalystops.telemetry.TelemetryService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JTable
import javax.swing.SwingConstants
import javax.swing.table.DefaultTableModel

private const val CACHE_TTL_MS = 60 * 60 * 1000L // 1 hour

class BillingPanel(private val project: Project) : JBPanel<BillingPanel>(BorderLayout()) {

    // In-memory cache
    private var cachedRows: List<Map<String, String>>? = null
    private var cacheTimestamp: Long = 0L

    private val statusLabel = JBLabel("Click Refresh to load billing data.", SwingConstants.CENTER)
    private val refreshButton = JButton("Refresh")
    private val dayButton = JButton("Day")
    private val weekButton = JButton("Week")
    private val monthButton = JButton("Month")
    private var currentPeriod = "week"

    private val tableModel = DefaultTableModel(
        arrayOf("SKU", "Unit", "Total Usage", "Est. Cost"),
        0
    )
    private val table = JTable(tableModel).apply {
        isEnabled = false
        fillsViewportHeight = true
    }

    private val totalLabel = JBLabel("Total: —", SwingConstants.CENTER).apply {
        font = font.deriveFont(font.size2D + 4f)
        border = JBUI.Borders.empty(8)
    }

    init {
        border = JBUI.Borders.empty(4)

        val periodPanel = JPanel().apply {
            add(dayButton)
            add(weekButton)
            add(monthButton)
        }

        val topPanel = JPanel(BorderLayout()).apply {
            add(periodPanel, BorderLayout.WEST)
            add(statusLabel, BorderLayout.CENTER)
            add(refreshButton, BorderLayout.EAST)
        }

        val contentPanel = JPanel(GridBagLayout()).apply {
            val gbc = GridBagConstraints().apply {
                fill = GridBagConstraints.HORIZONTAL
                weightx = 1.0
                gridx = 0
                gridy = 0
                insets = JBUI.insets(4)
            }
            add(totalLabel, gbc)
            gbc.gridy = 1
            gbc.fill = GridBagConstraints.BOTH
            gbc.weighty = 1.0
            add(JBScrollPane(table), gbc)
        }

        add(topPanel, BorderLayout.NORTH)
        add(contentPanel, BorderLayout.CENTER)

        refreshButton.addActionListener { loadBillingData(forceRefresh = true) }
        dayButton.addActionListener { currentPeriod = "day"; loadBillingData() }
        weekButton.addActionListener { currentPeriod = "week"; loadBillingData() }
        monthButton.addActionListener { currentPeriod = "month"; loadBillingData() }
    }

    fun loadBillingData(forceRefresh: Boolean = false) {
        val settings = DatabricksSettings.getInstance(project).state
        if (settings.host.isEmpty() || settings.token.isEmpty()) {
            statusLabel.text = "Configure Databricks connection first."
            return
        }

        val now = System.currentTimeMillis()
        val cached = cachedRows
        if (!forceRefresh && cached != null && (now - cacheTimestamp) < CACHE_TTL_MS) {
            renderBillingData(cached, settings.dbuRatePerHour, fromCache = true)
            return
        }

        statusLabel.text = "Loading billing data…"
        refreshButton.isEnabled = false
        TelemetryService.track("billing/dashboard_opened", mapOf("period" to currentPeriod, "force_refresh" to forceRefresh.toString()))

        object : Task.Backgroundable(project, "CatalystOps: Loading billing…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = buildClient(settings)

                    // Auto-discover warehouse if not configured
                    val warehouseId = settings.warehouseId.ifEmpty {
                        indicator.text = "Discovering SQL warehouse…"
                        val warehouses = client.listWarehouses()
                        warehouses.firstOrNull { it.state == "RUNNING" }?.id
                            ?: warehouses.firstOrNull()?.id
                            ?: throw RuntimeException("No SQL warehouses found. Configure a warehouse ID in settings.")
                    }

                    val sql = buildBillingSql(currentPeriod)
                    indicator.text = "Querying billing data…"
                    val rows = client.queryBilling(warehouseId, sql)

                    cachedRows = rows
                    cacheTimestamp = System.currentTimeMillis()

                    TelemetryService.track("billing/fetch_complete", mapOf(
                        "period" to currentPeriod,
                        "row_count" to rows.size.toString()
                    ))

                    ApplicationManager.getApplication().invokeLater {
                        renderBillingData(rows, settings.dbuRatePerHour, fromCache = false)
                        refreshButton.isEnabled = true
                    }
                } catch (ex: Exception) {
                    val msg = ex.message ?: ex.javaClass.simpleName
                    TelemetryService.track("billing/fetch_failed", mapOf("period" to currentPeriod, "error" to msg.take(200)))
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "Error: ${msg.take(120)}"
                        refreshButton.isEnabled = true
                    }
                }
            }
        }.queue()
    }

    private fun renderBillingData(rows: List<Map<String, String>>, dbuRate: Double, fromCache: Boolean) {
        tableModel.rowCount = 0

        var totalUsage = 0.0
        for (row in rows) {
            val sku = row["sku_name"] ?: ""
            val unit = row["usage_unit"] ?: ""
            val usage = row["total_usage"]?.toDoubleOrNull() ?: 0.0
            totalUsage += usage
            val estCost = if (unit.contains("DBU", ignoreCase = true)) {
                "~\$${String.format("%.4f", usage * dbuRate)}"
            } else {
                "—"
            }
            tableModel.addRow(arrayOf(sku, unit, String.format("%.2f", usage), estCost))
        }

        val totalCost = totalUsage * dbuRate
        totalLabel.text = "Total DBUs: ${String.format("%.2f", totalUsage)}  ·  Est. Cost: ~\$${String.format("%.2f", totalCost)}"

        val cacheNote = if (fromCache) " (cached)" else ""
        val updatedAt = SimpleDateFormat("HH:mm:ss").format(Date())
        statusLabel.text = "${rows.size} row(s) · ${currentPeriod.replaceFirstChar { it.uppercase() }} · Updated $updatedAt$cacheNote"
    }

    private fun buildBillingSql(period: String): String {
        val days = when (period) {
            "day" -> 1
            "week" -> 7
            "month" -> 30
            else -> 7
        }
        return """
            SELECT
              usage_date,
              sku_name,
              usage_unit,
              SUM(usage_quantity) as total_usage
            FROM system.billing.usage
            WHERE usage_date >= DATEADD(DAY, -$days, CURRENT_DATE())
            GROUP BY usage_date, sku_name, usage_unit
            ORDER BY usage_date DESC
        """.trimIndent()
    }

    private fun buildClient(settings: DatabricksSettings.State): DatabricksClient {
        val host = normalizeHost(settings.host)
        return DatabricksClient(host, settings.token)
    }

    private fun normalizeHost(host: String): String {
        val h = host.trimEnd('/')
        return if (h.startsWith("https://") || h.startsWith("http://")) h else "https://$h"
    }
}
