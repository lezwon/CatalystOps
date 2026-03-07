package com.catalystops.toolwindow

import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import java.awt.Component
import javax.swing.JList
import javax.swing.ListCellRenderer

class IssueCellRenderer : ListCellRenderer<ProblemDescriptor> {

    override fun getListCellRendererComponent(
        list: JList<out ProblemDescriptor>,
        value: ProblemDescriptor?,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        val component = SimpleColoredComponent()
        if (value == null) return component

        val element = value.psiElement
        val file = element?.containingFile
        val line = if (file != null && element != null) {
            val doc = com.intellij.openapi.editor.Document::class.java
            val docManager = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
            val virtualFile = file.virtualFile
            if (virtualFile != null) {
                val document = docManager.getDocument(virtualFile)
                if (document != null) {
                    document.getLineNumber(element.textOffset) + 1
                } else -1
            } else -1
        } else -1

        val linePrefix = if (line >= 0) "Line $line: " else ""
        component.append(linePrefix, SimpleTextAttributes.GRAYED_ATTRIBUTES)
        component.append(value.descriptionTemplate, SimpleTextAttributes.REGULAR_ATTRIBUTES)

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
