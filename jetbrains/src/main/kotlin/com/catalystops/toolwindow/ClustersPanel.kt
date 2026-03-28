package com.catalystops.toolwindow

import com.catalystops.databricks.ClusterInfo
import com.catalystops.databricks.DatabricksClient
import com.catalystops.settings.DatabricksSettings
import com.catalystops.telemetry.TelemetryService
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JMenuItem
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.ListSelectionModel
import javax.swing.SwingConstants

class ClustersPanel(private val project: Project) : JBPanel<ClustersPanel>(BorderLayout()) {

    private val model = DefaultListModel<ClusterInfo>()
    private val list = JBList(model).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = ClusterCellRenderer()
    }
    private val statusLabel = JBLabel("Click Refresh to load clusters.", SwingConstants.CENTER)
    private val refreshButton = JButton("Refresh")

    init {
        border = JBUI.Borders.empty(4)

        val topPanel = JPanel(BorderLayout()).apply {
            add(refreshButton, BorderLayout.WEST)
            add(statusLabel, BorderLayout.CENTER)
        }

        add(topPanel, BorderLayout.NORTH)
        add(JBScrollPane(list), BorderLayout.CENTER)

        refreshButton.addActionListener { refreshClusters() }

        list.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                if (e.isPopupTrigger) showContextMenu(e)
            }

            override fun mouseReleased(e: MouseEvent) {
                if (e.isPopupTrigger) showContextMenu(e)
            }
        })
    }

    private fun showContextMenu(e: MouseEvent) {
        val idx = list.locationToIndex(e.point)
        if (idx < 0) return
        list.selectedIndex = idx
        val cluster = model.getElementAt(idx) ?: return

        val popup = JPopupMenu()

        val sshItem = JMenuItem("Connect via SSH")
        sshItem.addActionListener { connectViaSsh(cluster) }
        popup.add(sshItem)

        popup.addSeparator()

        val startItem = JMenuItem("Start Cluster")
        startItem.isEnabled = cluster.state == "TERMINATED" || cluster.state == "UNKNOWN"
        startItem.addActionListener { startCluster(cluster) }
        popup.add(startItem)

        val stopItem = JMenuItem("Stop Cluster")
        stopItem.isEnabled = cluster.state == "RUNNING" || cluster.state == "PENDING"
        stopItem.addActionListener { stopCluster(cluster) }
        popup.add(stopItem)

        popup.show(list, e.x, e.y)
    }

    private fun refreshClusters() {
        val settings = DatabricksSettings.getInstance(project).state
        if (settings.host.isEmpty() || settings.token.isEmpty()) {
            statusLabel.text = "Configure Databricks connection first."
            return
        }

        statusLabel.text = "Loading clusters…"
        refreshButton.isEnabled = false
        TelemetryService.track("clusters/refresh_start")

        object : Task.Backgroundable(project, "CatalystOps: Loading clusters…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = buildClient(settings)
                    val clusters = client.listClusters()
                    ApplicationManager.getApplication().invokeLater {
                        model.clear()
                        clusters.forEach { model.addElement(it) }
                        statusLabel.text = "${clusters.size} cluster(s). Right-click for actions."
                        refreshButton.isEnabled = true
                        TelemetryService.track("clusters/refresh_complete", mapOf("count" to clusters.size.toString()))
                    }
                } catch (ex: Exception) {
                    val msg = ex.message ?: ex.javaClass.simpleName
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "Error: ${msg.take(100)}"
                        refreshButton.isEnabled = true
                        TelemetryService.track("clusters/refresh_failed", mapOf("error" to msg.take(200)))
                    }
                }
            }
        }.queue()
    }

    private fun startCluster(cluster: ClusterInfo) {
        val settings = DatabricksSettings.getInstance(project).state
        statusLabel.text = "Starting \"${cluster.clusterName}\"…"

        object : Task.Backgroundable(project, "CatalystOps: Starting cluster…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = buildClient(settings)
                    client.startCluster(cluster.clusterId)
                    TelemetryService.track("cluster/start", mapOf("clusterState" to cluster.state))

                    // Poll until RUNNING
                    indicator.text = "Waiting for cluster to start…"
                    val deadline = System.currentTimeMillis() + 10 * 60 * 1000L
                    var state = "PENDING"
                    while (state != "RUNNING" && state != "ERROR" && state != "TERMINATED") {
                        if (System.currentTimeMillis() > deadline) {
                            ApplicationManager.getApplication().invokeLater {
                                statusLabel.text = "Timed out waiting for \"${cluster.clusterName}\" to start."
                            }
                            return
                        }
                        Thread.sleep(3000)
                        state = client.getClusterState(cluster.clusterId)
                        ApplicationManager.getApplication().invokeLater {
                            statusLabel.text = "Cluster state: $state…"
                        }
                    }

                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "\"${cluster.clusterName}\" is $state."
                        refreshClusters()
                    }
                } catch (ex: Exception) {
                    val msg = ex.message ?: ex.javaClass.simpleName
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "Error starting cluster: ${msg.take(100)}"
                    }
                }
            }
        }.queue()
    }

    private fun stopCluster(cluster: ClusterInfo) {
        val confirm = Messages.showYesNoDialog(
            project,
            "Stop cluster \"${cluster.clusterName}\"? Running jobs will be terminated.",
            "Stop Cluster",
            Messages.getWarningIcon()
        )
        if (confirm != Messages.YES) return

        val settings = DatabricksSettings.getInstance(project).state
        statusLabel.text = "Stopping \"${cluster.clusterName}\"…"

        object : Task.Backgroundable(project, "CatalystOps: Stopping cluster…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = buildClient(settings)
                    client.terminateCluster(cluster.clusterId)
                    TelemetryService.track("cluster/stop", mapOf("clusterState" to cluster.state))
                    Thread.sleep(2000)
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "\"${cluster.clusterName}\" is terminating."
                        refreshClusters()
                    }
                } catch (ex: Exception) {
                    val msg = ex.message ?: ex.javaClass.simpleName
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "Error stopping cluster: ${msg.take(100)}"
                    }
                }
            }
        }.queue()
    }

    private fun connectViaSsh(cluster: ClusterInfo) {
        val settings = DatabricksSettings.getInstance(project).state
        statusLabel.text = "Setting up SSH for \"${cluster.clusterName}\"…"

        object : Task.Backgroundable(project, "CatalystOps: SSH Setup…", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val client = buildClient(settings)

                    // Step 1: If TERMINATED, offer to start
                    if (cluster.state == "TERMINATED") {
                        var startIt = false
                        ApplicationManager.getApplication().invokeAndWait {
                            val ans = Messages.showYesNoDialog(
                                project,
                                "Cluster \"${cluster.clusterName}\" is terminated. Start it before connecting?",
                                "Start Cluster?",
                                Messages.getQuestionIcon()
                            )
                            startIt = (ans == Messages.YES)
                        }
                        if (!startIt) {
                            ApplicationManager.getApplication().invokeLater { statusLabel.text = "SSH cancelled." }
                            return
                        }

                        indicator.text = "Starting cluster…"
                        client.startCluster(cluster.clusterId)
                        val deadline = System.currentTimeMillis() + 10 * 60 * 1000L
                        var state = "PENDING"
                        while (state != "RUNNING" && state != "ERROR" && state != "TERMINATED") {
                            if (System.currentTimeMillis() > deadline) {
                                ApplicationManager.getApplication().invokeLater {
                                    statusLabel.text = "Timed out waiting for cluster to start."
                                }
                                return
                            }
                            Thread.sleep(3000)
                            state = client.getClusterState(cluster.clusterId)
                            indicator.text = "Cluster state: $state…"
                        }
                        if (state != "RUNNING") {
                            ApplicationManager.getApplication().invokeLater {
                                statusLabel.text = "Cluster failed to start (state: $state)."
                            }
                            return
                        }
                    }

                    // Step 2: Run databricks ssh setup
                    indicator.text = "Running databricks ssh setup…"
                    val sanitizedName = cluster.clusterName
                        .lowercase()
                        .replace(Regex("\\s+"), "_")
                        .replace(Regex("[^a-z0-9_-]"), "")
                        .trimStart('-', '_')
                        .trimEnd('-', '_')
                        .ifEmpty { "cluster-${cluster.clusterId.take(8)}" }

                    val pb = ProcessBuilder(
                        "databricks", "ssh", "setup",
                        "--name", sanitizedName,
                        "--cluster", cluster.clusterId,
                        "--profile", "DEFAULT"
                    )
                    pb.redirectErrorStream(true)
                    pb.environment()["PATH"] = listOf(
                        pb.environment()["PATH"] ?: "",
                        "/opt/homebrew/bin",
                        "/usr/local/bin",
                        "${System.getProperty("user.home")}/.local/bin",
                        "${System.getProperty("user.home")}/.databricks/bin"
                    ).filter { it.isNotEmpty() }.joinToString(":")

                    val proc = pb.start()
                    val output = proc.inputStream.bufferedReader().readText().trim()
                    val exitCode = proc.waitFor()

                    if (exitCode != 0) {
                        // Check if it's an access mode error
                        if (output.contains("dedicated access mode", ignoreCase = true) ||
                            output.contains("single.?user".toRegex(RegexOption.IGNORE_CASE))
                        ) {
                            var fixIt = false
                            ApplicationManager.getApplication().invokeAndWait {
                                val ans = Messages.showYesNoDialog(
                                    project,
                                    "Cluster \"${cluster.clusterName}\" needs Single User access mode for SSH.\n" +
                                        "Fix automatically (set data_security_mode to SINGLE_USER)?",
                                    "Fix Access Mode?",
                                    Messages.getWarningIcon()
                                )
                                fixIt = (ans == Messages.YES)
                            }
                            if (fixIt) {
                                indicator.text = "Updating cluster access mode…"
                                client.editCluster(cluster.clusterId, mapOf("data_security_mode" to "SINGLE_USER"))
                                ApplicationManager.getApplication().invokeLater {
                                    statusLabel.text = "Access mode updated. Restart the cluster and try SSH again."
                                }
                            } else {
                                ApplicationManager.getApplication().invokeLater {
                                    statusLabel.text = "SSH setup cancelled."
                                }
                            }
                            return
                        }

                        ApplicationManager.getApplication().invokeLater {
                            statusLabel.text = "SSH setup failed (exit $exitCode): ${output.take(100)}"
                        }
                        showNotification(
                            "CatalystOps SSH Setup Failed",
                            "databricks ssh setup exited $exitCode.\n$output\n\n" +
                                "Run manually: databricks ssh setup --name $sanitizedName --cluster ${cluster.clusterId} --profile DEFAULT",
                            NotificationType.ERROR
                        )
                        return
                    }

                    // Step 3: Show SSH connection details
                    val sshHost = sanitizedName
                    val sshInfo = "SSH configured!\n\nHost alias: $sshHost\n\nConnect with:\n  ssh $sshHost\n\n" +
                        "Or open JetBrains Gateway and use SSH connection:\n  Host: $sshHost"

                    TelemetryService.track("cluster/ssh_connect", mapOf("clusterState" to cluster.state))

                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "SSH ready: $sshHost"
                        Messages.showInfoMessage(project, sshInfo, "SSH Connection Details")
                    }
                } catch (ex: Exception) {
                    val msg = ex.message ?: ex.javaClass.simpleName
                    TelemetryService.track("cluster/ssh_failed", mapOf("error" to msg.take(200)))
                    ApplicationManager.getApplication().invokeLater {
                        statusLabel.text = "SSH error: ${msg.take(100)}"
                    }
                }
            }
        }.queue()
    }

    private fun showNotification(title: String, content: String, type: NotificationType) {
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("CatalystOps")
                .createNotification(title, content, type)
                .notify(project)
        }
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
