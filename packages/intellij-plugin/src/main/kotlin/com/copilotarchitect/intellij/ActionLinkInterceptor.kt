package com.copilotarchitect.intellij

import com.intellij.ui.jcef.JBCefBrowser
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest

private const val ACTION_SCHEME_PREFIX = "architect-action:"

/**
 * Intercepts clicks on the dashboard's `architect-action:` links — the
 * host-neutral scheme `packages/cli`'s `dashboard` command renders its action
 * row on (see `buildDashboardActionsHtml` in `packages/cli/src/index.ts`) —
 * before JCEF tries to navigate to them as a real URL, and routes the action
 * id to [onAction] instead. VS Code's equivalent is its own `command:` URI
 * scheme, handled natively by the webview; JCEF has no such built-in
 * convention, so this plugin defines and intercepts its own.
 *
 * UNVERIFIED (Phase 2): written against the JCEF request-handler API bundled
 * with the IntelliJ Platform, but — like the rest of this package — never
 * built in this environment; see CliBridge.kt's Phase 1 note and the plugin
 * README for why (JetBrains' distribution hosts are network-blocked here).
 * Treat this interception as unproven until it has run in a real IDE.
 */
fun JBCefBrowser.interceptActionLinks(onAction: (String) -> Unit) {
    jbCefClient.addRequestHandler(
        object : CefRequestHandlerAdapter() {
            override fun onBeforeBrowse(
                browser: CefBrowser?,
                frame: CefFrame?,
                request: CefRequest?,
                userGesture: Boolean,
                isRedirect: Boolean
            ): Boolean {
                val url = request?.url ?: return false
                if (url.startsWith(ACTION_SCHEME_PREFIX)) {
                    onAction(url.removePrefix(ACTION_SCHEME_PREFIX))
                    return true
                }
                return false
            }
        },
        cefBrowser
    )
}
