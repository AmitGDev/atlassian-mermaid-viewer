/**
 * mermaid-viewer.js
 *
 * Content script - runs in the browser's isolated world at document_idle.
 * Supports Chrome, Edge (Chromium), and Firefox.
 *
 * Content scripts cannot directly share globals (like `window.mermaid`)
 * with the host page. To work around this, we inject both mermaid.min.js and
 * mermaid-page.js into the page as <script src="..."> tags, so they execute
 * in the page's own JavaScript context where the mermaid global is accessible.
 *
 * Both files are declared as web_accessible_resources in manifest.json, which
 * makes them available via browser-specific extension URLs:
 *   Chrome / Edge  chrome-extension://<id>/<filename>
 *   Firefox        moz-extension://<id>/<filename>
 * Confluence's CSP explicitly allows both chrome-extension:// and
 * moz-extension:// origins for scripts, so the injection is not blocked on
 * any supported browser.
 *
 * Responsibilities:
 *  - Inject mermaid.min.js into the page context
 *  - Inject mermaid-page.js once Mermaid is ready
 */
(function () {
    'use strict';

    // ─── Script injection ─────────────────────────────────────────────────────

    /**
     * Injects a script into the page by appending a <script src="url"> tag.
     * The script runs in the page's JavaScript context (not the content-script world).
     * @param {string} url        - The extension URL of the script to inject
     *                              (chrome-extension:// on Chrome/Edge, moz-extension:// on Firefox).
     * @param {Function} [onload] - Optional callback fired after the script has loaded.
     */
    function injectScript(url, onload) {
        const s = document.createElement('script');
        s.src = url;
        if (onload) s.onload = onload;
        document.head.appendChild(s);
    }

    // ─── Resource URLs ────────────────────────────────────────────────────────

    // Resolve the chrome-extension:// URLs for our bundled resources
    const mermaidUrl = browser.runtime.getURL('vendors/mermaid.min.js');
    const pageUrl    = browser.runtime.getURL('mermaid-page.js');

    // ─── Injection sequence ───────────────────────────────────────────────────

    // Load Mermaid first; only inject our viewer logic once Mermaid is ready
    injectScript(mermaidUrl, () => injectScript(pageUrl));

})();