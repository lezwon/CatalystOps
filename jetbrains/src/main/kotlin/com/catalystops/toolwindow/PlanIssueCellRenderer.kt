package com.catalystops.toolwindow

import com.catalystops.analysis.PlanIssue
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import java.awt.Component
import javax.swing.JList
import javax.swing.ListCellRenderer

class PlanIssueCellRenderer : ListCellRenderer<PlanIssue> {

    override fun getListCellRendererComponent(
        list: JList<out PlanIssue>,
        value: PlanIssue?,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        val component = SimpleColoredComponent()
        if (value == null) return component

        val costLabel = when {
            value.costPoints >= 80 -> "[CRITICAL] "
            value.costPoints >= 30 -> "[WARN] "
            else -> "[INFO] "
        }
        component.append(costLabel, SimpleTextAttributes.GRAYED_ATTRIBUTES)
        component.append(value.name + ": ", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
        // Show first line of description only
        val firstLine = value.description.lines().firstOrNull() ?: value.description
        component.append(firstLine, SimpleTextAttributes.REGULAR_ATTRIBUTES)

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
