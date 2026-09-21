package com.copilotarchitect.intellij

import java.awt.Color
import javax.swing.UIManager

/**
 * Maps the current IntelliJ Look and Feel to the `--vscode-*` custom
 * property names the shared dashboard HTML already uses (see
 * `packages/dashboard`, which VS Code's own `--vscode-*` theme variables
 * back directly). Reusing those exact names outside VS Code is a naming
 * leak — harmless, since a CSS custom property name is just a string, but
 * worth a rename in a later phase; tracked in docs/KNOWN_LIMITATIONS.md.
 * The values are IntelliJ's own theme, resolved fresh on every render, so
 * the dashboard reads as native and follows a Light/Darcula switch.
 *
 * The `--vscode-charts-*` accent colors are the one exception: IntelliJ has
 * no equivalently standardized "chart palette" theme key, so these are the
 * same fixed values used for the VS Code Dark+ preview screenshot — they
 * will not adapt to a Light theme the way VS Code's own do. Also a known,
 * documented Phase 1 limitation.
 */
object ThemeColors {
    fun styleBlock(): String {
        val foreground = colorOf("Label.foreground", Color(0xCC, 0xCC, 0xCC))
        val editorBackground = colorOf("Panel.background", Color(0x1E, 0x1E, 0x1E))
        val sideBarBackground = colorOf("List.background", Color(0x25, 0x25, 0x26))
        val panelBorder = colorOf("Component.borderColor", Color(0x45, 0x45, 0x45))
        val description = colorOf("Label.disabledForeground", Color(0x9D, 0x9D, 0x9D))
        val link = colorOf("Link.activeForeground", Color(0x37, 0x94, 0xFF))
        val fontFamily = UIManager.getFont("Label.font")?.family ?: "sans-serif"

        return """
            |<style>
            |:root {
            |  --vscode-font-family: '$fontFamily', sans-serif;
            |  --vscode-foreground: ${toCss(foreground)};
            |  --vscode-editor-background: ${toCss(editorBackground)};
            |  --vscode-sideBar-background: ${toCss(sideBarBackground)};
            |  --vscode-panel-border: ${toCss(panelBorder)};
            |  --vscode-descriptionForeground: ${toCss(description)};
            |  --vscode-textLink-foreground: ${toCss(link)};
            |  --vscode-charts-blue: #3794ff;
            |  --vscode-charts-green: #89d185;
            |  --vscode-charts-purple: #b180d7;
            |  --vscode-charts-orange: #d18616;
            |  --vscode-charts-yellow: #d7ba7d;
            |  --vscode-charts-red: #f14c4c;
            |}
            |</style>
        """.trimMargin()
    }

    private fun colorOf(key: String, fallback: Color): Color = UIManager.getColor(key) ?: fallback

    private fun toCss(color: Color): String =
        String.format("#%02x%02x%02x", color.red, color.green, color.blue)
}
