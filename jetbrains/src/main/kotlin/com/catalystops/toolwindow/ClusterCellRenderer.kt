package com.catalystops.toolwindow

import com.catalystops.databricks.ClusterInfo
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import java.awt.Color
import java.awt.Component
import javax.swing.JList
import javax.swing.ListCellRenderer

class ClusterCellRenderer : ListCellRenderer<ClusterInfo> {

    override fun getListCellRendererComponent(
        list: JList<out ClusterInfo>,
        value: ClusterInfo?,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        val component = SimpleColoredComponent()
        if (value == null) return component

        component.append(value.clusterName, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)

        val stateColor = when (value.state) {
            "RUNNING" -> SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, Color(0x3DD68C))
            "TERMINATED", "TERMINATING" -> SimpleTextAttributes.GRAYED_ATTRIBUTES
            "PENDING", "RESTARTING", "RESIZING" -> SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, Color(0xF5A623))
            "ERROR" -> SimpleTextAttributes.ERROR_ATTRIBUTES
            else -> SimpleTextAttributes.GRAYED_ATTRIBUTES
        }
        component.append("  [${value.state}]", stateColor)

        val workers = if (value.numWorkers != null) " · ${value.numWorkers}w" else ""
        val sparkShort = value.sparkVersion.substringBefore("-").take(10)
        component.append("  $sparkShort$workers", SimpleTextAttributes.GRAY_ATTRIBUTES)

        if (isSelected) {
            component.background = list.selectionBackground
            component.foreground = list.selectionForeground
        } else {
            component.background = list.background
            component.foreground = list.foreground
        }
        component.isOpaque = true

        return component
    }
}
