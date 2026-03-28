package com.catalystops.toolwindow

import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import java.awt.Component
import javax.swing.JList
import javax.swing.ListCellRenderer

class JobCellRenderer : ListCellRenderer<JobWithRun> {

    override fun getListCellRendererComponent(
        list: JList<out JobWithRun>,
        value: JobWithRun?,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        val component = SimpleColoredComponent()
        if (value == null) return component

        component.append(value.job.name, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)

        val run = value.lastRun
        if (run != null) {
            val state = run.state.lifeCycleState
            val result = run.state.resultState
            val stateText = when {
                result != null -> "$state / $result"
                else -> state
            }
            val attr = when (result) {
                "SUCCESS" -> SimpleTextAttributes.GRAY_ATTRIBUTES
                "FAILED", "TIMEDOUT" -> SimpleTextAttributes.ERROR_ATTRIBUTES
                else -> SimpleTextAttributes.GRAYED_ATTRIBUTES
            }
            component.append("  [$stateText]", attr)
        } else {
            component.append("  [no runs]", SimpleTextAttributes.GRAYED_ATTRIBUTES)
        }

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
