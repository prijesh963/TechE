package com.copilotarchitect.intellij

import com.intellij.openapi.diagnostic.Logger
import com.intellij.ui.jcef.JBCefBrowser
import org.cef.CefSettings
import org.cef.browser.CefBrowser
import org.cef.handler.CefDisplayHandlerAdapter

private const val ACTION_SCHEME_PREFIX = "architect-action:"

/**
 * Prefix of the console message [clickScript] logs for each action click.
 * Deliberately not just [ACTION_SCHEME_PREFIX], so an unrelated
 * `console.log` of a link's href can never be mistaken for a click.
 */
private const val CONSOLE_MARKER = "copilot-architect-click:"

/**
 * Routes clicks on the dashboard's `architect-action:` links — the
 * host-neutral scheme `packages/cli`'s `dashboard` command renders its action
 * row on (see `buildDashboardActionsHtml` in `packages/cli/src/index.ts`) —
 * to [onAction]. VS Code's equivalent is its own `command:` URI scheme,
 * handled natively by the webview; JCEF has no such built-in convention.
 *
 * Two earlier approaches never delivered a click in a real IDE (IntelliJ
 * 2026.2), confirmed by hand rather than assumed:
 * - `CefRequestHandler.onBeforeBrowse`: Chromium treats the unregistered
 *   scheme as an external protocol and drops the navigation before any
 *   browse callback runs.
 * - `JBCefJSQuery`: only reachable from the page when created before the
 *   native browser is, or with `JS_QUERY_POOL_SIZE` set on the client; the
 *   plain `JBCefBrowser()` this panel creates did not satisfy either.
 *
 * So the transport is now the browser console, which has no such
 * preconditions: [clickScript] cancels the navigation and logs
 * [CONSOLE_MARKER] + the action id, and a display handler on the browser's
 * client picks it up. The script also shows an in-page "Running…" banner, so
 * a click that reaches the page is visible even if nothing after it works.
 */
class ActionLinkBridge(browser: JBCefBrowser, onAction: (actionId: String, text: String?) -> Unit) {
    private val log = Logger.getInstance(ActionLinkBridge::class.java)

    init {
        browser.jbCefClient.addDisplayHandler(
            object : CefDisplayHandlerAdapter() {
                override fun onConsoleMessage(
                    browser: CefBrowser?,
                    level: CefSettings.LogSeverity?,
                    message: String?,
                    source: String?,
                    line: Int
                ): Boolean {
                    if (message == null || !message.startsWith(CONSOLE_MARKER)) return false
                    // `<id>` alone, or `<id>\n<text>` for a link carrying a
                    // `data-input` box's value (the Copilot panel's buttons).
                    val payload = message.removePrefix(CONSOLE_MARKER)
                    val newline = payload.indexOf('\n')
                    val actionId = if (newline < 0) payload else payload.substring(0, newline)
                    val text = if (newline < 0) null else payload.substring(newline + 1)
                    log.info("Dashboard action clicked: $actionId")
                    onAction(actionId, text)
                    return true
                }
            },
            browser.cefBrowser
        )
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
          var banner = document.getElementById('copilot-architect-running');
          if (!banner) {
            banner = document.createElement('div');
            banner.id = 'copilot-architect-running';
            banner.style.cssText = 'position:sticky;top:0;z-index:1000;padding:6px 10px;' +
              'background:var(--vscode-editorWidget-background,#333);' +
              'color:var(--vscode-foreground,#fff);border-bottom:1px solid currentColor;';
            document.body.insertBefore(banner, document.body.firstChild);
          }
          banner.textContent = 'Running ' + (link.textContent || '').trim() + '…';
          var payload = href.substring(${ACTION_SCHEME_PREFIX.length});
          var inputId = link.getAttribute('data-input');
          if (inputId) {
            var input = document.getElementById(inputId);
            payload += '\n' + (input ? input.value : '');
          }
          console.log('$CONSOLE_MARKER' + payload);
        }, true);
        </script>
    """.trimIndent()
}
