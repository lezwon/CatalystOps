package com.catalystops.settings

import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.ButtonGroup
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPasswordField
import javax.swing.JRadioButton

class DatabricksSettingsPanel {

    val hostField = JBTextField()
    val tokenField = JPasswordField()
    val clusterIdField = JBTextField()
    val clusterModeRadio = JRadioButton("Cluster")
    val serverlessModeRadio = JRadioButton("Serverless")
    val timeoutField = JBTextField()
    val warehouseIdField = JBTextField()
    val dbuRateField = JBTextField()
    val serverlessRateField = JBTextField()
    val testConnectionButton = JButton("Test Connection")
    val testConnectionStatus = JLabel("")

    val panel: JBPanel<*>

    init {
        val modeGroup = ButtonGroup()
        modeGroup.add(clusterModeRadio)
        modeGroup.add(serverlessModeRadio)
        clusterModeRadio.isSelected = true

        val modePanel = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            add(clusterModeRadio)
            add(JBLabel("   "))
            add(serverlessModeRadio)
        }

        val testPanel = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            add(testConnectionButton)
            add(JBLabel("  "))
            add(testConnectionStatus)
        }

        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Databricks Host:"), hostField, 1, false)
            .addLabeledComponent(JBLabel("Token:"), tokenField, 1, false)
            .addLabeledComponent(JBLabel("Cluster ID:"), clusterIdField, 1, false)
            .addLabeledComponent(JBLabel("Execution Mode:"), modePanel, 1, false)
            .addLabeledComponent(JBLabel("Timeout (seconds):"), timeoutField, 1, false)
            .addSeparator()
            .addLabeledComponent(JBLabel("SQL Warehouse ID (billing):"), warehouseIdField, 1, false)
            .addLabeledComponent(JBLabel("DBU Rate/Hour (\$):"), dbuRateField, 1, false)
            .addLabeledComponent(JBLabel("Serverless Rate/Hour (\$):"), serverlessRateField, 1, false)
            .addComponent(testPanel)
            .addComponentFillVertically(JBPanel<JBPanel<*>>(BorderLayout()), 0)
            .panel
            .also { it.border = JBUI.Borders.empty(8) }
            .let { inner ->
                JBPanel<JBPanel<*>>(BorderLayout()).apply {
                    add(inner, BorderLayout.NORTH)
                }
            }
    }

    fun getExecutionMode(): String = if (serverlessModeRadio.isSelected) "serverless" else "cluster"

    fun setExecutionMode(mode: String) {
        if (mode == "serverless") {
            serverlessModeRadio.isSelected = true
        } else {
            clusterModeRadio.isSelected = true
        }
    }
}
