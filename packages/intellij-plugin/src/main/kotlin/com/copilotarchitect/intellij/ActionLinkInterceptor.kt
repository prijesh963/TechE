package com.copilotarchitect.intellij

import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery

private const val ACTION_SCHEME_PREFIX = "architect-action:"

/**
 * Routes clicks on the dashboard's `architect-action:` links — the
 * host-neutral scheme `packages/cli`'s `dashboard` command renders its action
 * row on (see `buildDashboardActionsHtml` in `packages/cli/src/index.ts`) —
 * to [onAction]. VS Code's equivalent is its own `command:` URI scheme,
 * handled natively by the webview; JCEF has no such built-in convention.
 *
 * The first version intercepted these in `CefRequestHandler.onBeforeBrowse`.
 * In a real IDE that never fired: Chromium treats an unregistered scheme as
 * an external protocol and drops the navigation before any browse callback
 * runs, so every action link rendered but did nothing when clicked. Instead,
 * [clickScript] is injected into each rendered page: a capture-phase click
 * listener that cancels the navigation itself and hands the action id to
 * Kotlin through a [JBCefJSQuery] — the IntelliJ Platform's supported
 * JS-to-host bridge.
 *
 * Must be constructed before the browser loads its first page: a
 * [JBCefJSQuery] created after the native browser exists is not guaranteed
 * to be reachable from the page.
 */
class ActionLinkBridge(browser: JBCefBrowser, onAction: (String) -> Unit) {
    private val query: JBCefJSQuery = JBCefJSQuery.create(browser)

    init {
        Disposer.register(browser, query)
        query.addHandler { actionId ->
            onAction(actionId)
            null
        }
    }

    /** A `<script>` block to put in the page's `<head>`. */
    fun clickScript(): String = """
        <script>
        document.addEventListener('click', function (event) {
          var target = event.target;
          var link = target && target.closest ? target.closest('a[href]') : null;
          if (!link) return;
          var href = link.getAttribute('href') || '';
          if (href.indexOf('$ACTION_SCHEME_PREFIX') !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          var id = href.substring(${ACTION_SCHEME_PREFIX.length});
          document.body.style.cursor = 'progress';
          ${query.inject("id")}
        }, true);
        </script>
    """.trimIndent()
}
