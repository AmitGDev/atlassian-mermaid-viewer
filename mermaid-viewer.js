/**
 * mermaid-viewer.js
 *
 * Content script — runs in Chrome's isolated world at document_idle.
 *
 * Chrome content scripts cannot directly share globals (like `window.mermaid`)
 * with the host page. To work around this, we inject both mermaid.min.js and
 * mermaid-page.js into the page as <script src="..."> tags, so they execute
 * in the page's own JavaScript context where the mermaid global is accessible.
 *
 * Both files are declared as web_accessible_resources in manifest.json, which
 * makes them available at chrome-extension://<id>/<filename> URLs.
 * Confluence's CSP explicitly allows chrome-extension:// origins for scripts,
 * so the injection is not blocked.
 *
 * Responsibilities:
 *  - Inject mermaid.min.js into the page context
 *  - Resolve team-wide Mermaid config from a Confluence attachment
 *  - Bridge the resolved config to mermaid-page.js via dataset.mermaidConfig
 *  - Inject mermaid-page.js once both Mermaid and the config are ready
 */
(function () {
    'use strict';

    // ─── Script injection ─────────────────────────────────────────────────────

    /**
     * Injects a script into the page by appending a <script src="url"> tag.
     * The script runs in the page's JavaScript context (not the content-script world).
     * @param {string} url        - The chrome-extension:// URL of the script to inject.
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
    const mermaidUrl = chrome.runtime.getURL('vendors/mermaid.min.js');
    const pageUrl    = chrome.runtime.getURL('mermaid-page.js');

    // ─── Config resolution ────────────────────────────────────────────────────

    /**
     * Extension defaults applied when no Confluence config is present or when
     * the attachment omits a field.  The resolved config is merged on top of
     * these values, so the attachment only needs to specify overrides.
     *
     * startOnLoad: false  - we drive rendering ourselves via mermaid.render();
     *                       letting Mermaid scan the page would double-render.
     * securityLevel: 'strict' - prevents raw HTML injection in node labels.
     *                           Do not relax without a dedicated sanitisation
     *                           ticket (see AMV-28).
     */
    const MERMAID_DEFAULTS = {
        startOnLoad:   false,
        look:          'handDrawn',
        theme:         'default',
        securityLevel: 'strict',
    };

    /**
     * Type contract for the fields the extension accepts from the config
     * attachment.  Maps directly to Mermaid's init config schema.
     * Validation is for correctness only -- not a security boundary.
     * Unknown keys are silently dropped; see AMV-25 for rationale.
     */
    const CONFIG_SCHEMA = {
        theme:         'string',
        look:          'string',
        fontFamily:    'string',
        securityLevel: 'string',
    };

    /** @type {object|null} */
    let resolvedConfigCache = null;

    /**
     * Space key of the well-known global config space.
     *
     * Organizations that want a consistent Mermaid config across all Atlassian
     * surfaces -- Confluence and Jira alike -- create a Confluence space with
     * this exact key and add a config page to it.
     *
     * The key is intentionally unique and purpose-specific to minimise the
     * chance of collision with an existing space in any organization.
     * It is hardcoded rather than user-configurable to prevent individual users
     * from redirecting config resolution to a space they control, which would
     * allow them to override security-sensitive settings such as securityLevel.
     */
    const GLOBAL_CONFIG_SPACE_KEY = 'AMVCENTRAL';

    /**
     * Extracts the Confluence space key from the current URL.
     * Confluence space URLs follow the pattern /wiki/spaces/<KEY>/...
     * Returns null on Jira pages or any URL that does not contain a space key.
     * @returns {string|null}
     */
    function extractSpaceKey() {
        const match = window.location.pathname.match(/\/wiki\/spaces\/([^/]+)\//);
        return match ? match[1] : null;
    }

    /**
     * Validates a raw parsed config object against CONFIG_SCHEMA.
     * Accepts only fields present in the schema whose runtime type matches.
     * Returns a new object containing only the valid fields.
     * @param {object} raw
     * @returns {object}
     */
    function validateConfig(raw) {
        const safe = {};
        for (const [key, type] of Object.entries(CONFIG_SCHEMA)) {
            if (key in raw && typeof raw[key] === type) safe[key] = raw[key];
        }
        return safe;
    }

    /**
     * Extracts a JSON string from a Confluence storage-format body.
     *
     * Supports two admin workflows -- both are equivalent from the extension's
     * perspective:
     *
     *   1. Code block  -- admin pastes the JSON inside a Confluence code block.
     *                     Stored as <ac:plain-text-body><![CDATA[...]]></ac:plain-text-body>.
     *                     The CDATA content is extracted directly; no tag stripping needed.
     *
     *   2. Plain text  -- admin pastes the JSON directly into the page body.
     *                     Stored inside <p> tags with possible whitespace.
     *                     All XML tags are stripped; the remaining text is trimmed.
     *
     * In both cases the result is fed into JSON.parse.  A parse failure returns
     * null and the caller falls back to MERMAID_DEFAULTS.
     * @param {string} storageBody  - The raw storage-format XML string from the API.
     * @returns {string|null}       - The extracted JSON string, or null if not found.
     */
    function extractJsonFromBody(storageBody) {
        // Code block path: extract CDATA content from an ac:plain-text-body element.
        const cdataMatch = storageBody.match(
            /<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/
        );
        if (cdataMatch) return cdataMatch[1].trim();

        // Plain text path: strip all XML/HTML tags, decode HTML entities, and trim.
        // Entity decoding is required because Confluence encodes characters such as
        // double quotes as &quot; in plain <p> body content, which would otherwise
        // cause JSON.parse to fail on syntactically valid JSON.
        // The code block path (CDATA) is immune -- CDATA is never entity-encoded.
        const stripped = storageBody
            .replace(/<[^>]+>/g, '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g,  '&')
            .replace(/&lt;/g,   '<')
            .replace(/&gt;/g,   '>')
            .replace(/&#39;/g,  "'")
            .trim();
        return stripped.length > 0 ? stripped : null;
    }

    /**
     * Fetches the body of the well-known config Confluence page
     * in the given space and parses the JSON config from it.
     *
     * Single REST call -- page ID and body are resolved together via
     * expand=body.storage.  This is a deliberate simplification over the
     * earlier attachment-based design (3 calls); see AMV-25 comments.
     *
     * The page body may contain the JSON either as plain text or inside a
     * code block -- both are handled by extractJsonFromBody().
     *
     * Returns the parsed JSON object on success, or null on any failure
     * (page not found, body absent, malformed JSON, network error).
     * Failures are silent -- callers fall back to MERMAID_DEFAULTS.
     * @param {string} spaceKey
     * @returns {Promise<object|null>}
     */
    async function fetchPageConfig(spaceKey) {
        try {
            const res = await fetch(
                `/wiki/rest/api/content?title=config&spaceKey=${encodeURIComponent(spaceKey)}&expand=body.storage&limit=1`
            );
            if (!res.ok) return null;

            const data = await res.json();
            const storageBody = data?.results?.[0]?.body?.storage?.value;
            if (!storageBody) return null;

            const jsonText = extractJsonFromBody(storageBody);
            if (!jsonText) return null;

            return JSON.parse(jsonText);
        } catch {
            return null;
        }
    }

    /**
     * Resolves the final Mermaid config for this tab.
     *
     * Resolution order:
     *   1. Current Confluence space -- if a mermaid-viewer-config page exists in
     *      the space being browsed, its config takes precedence.  This gives
     *      individual teams the flexibility to override the org-wide config.
     *   2. AMV-CENTRAL global space -- if the current space has no config page,
     *      or if the current page is in Jira (no space key in the URL), the
     *      extension falls back to the well-known global space.  This ensures a
     *      consistent look across all Atlassian surfaces without per-space setup.
     *   3. MERMAID_DEFAULTS -- if both fetches fail or return nothing, defaults
     *      apply silently.  No error is surfaced to the page.
     *
     * The result is cached in resolvedConfigCache for the lifetime of the
     * content script process (per-tab).  chrome.storage is intentionally not
     * used -- see AMV-25 comments.
     * @returns {Promise<object>}
     */
    async function resolveConfig() {
        if (resolvedConfigCache) return resolvedConfigCache;

        const spaceKey  = extractSpaceKey();
        const localRaw  = spaceKey && spaceKey !== GLOBAL_CONFIG_SPACE_KEY
                            ? await fetchPageConfig(spaceKey)
                            : null;
        const globalRaw = localRaw ? null : await fetchPageConfig(GLOBAL_CONFIG_SPACE_KEY);
        const raw       = localRaw ?? globalRaw;
        const override  = raw ? validateConfig(raw) : {};

        resolvedConfigCache = { ...MERMAID_DEFAULTS, ...override };
        return resolvedConfigCache;
    }

    // ─── Icon tinting ─────────────────────────────────────────────────────────

    // Fetch icon.svg, tint to Mermaid Live brand pink, and store in the shared
    // DOM so mermaid-page.js can read it synchronously from the page context.
    const iconReady = fetch(chrome.runtime.getURL('assets/icon.svg'))
        .then(r => r.text())
        .then(svg => {
            document.documentElement.dataset.mermaidIconSvg =
                svg.replace(/<rect\b([^>]*?)fill="[^"]*"/, '<rect$1fill="#FF3670"');
        });

    // ─── Config bridging ──────────────────────────────────────────────────────

    // Resolve the team-wide config and write it to dataset.mermaidConfig so
    // mermaid-page.js can read it synchronously from the page context before
    // calling mermaid.initialize().  Identical bridging pattern to icon.svg.
    const configReady = resolveConfig().then(config => {
        document.documentElement.dataset.mermaidConfig = JSON.stringify(config);
    });

    // ─── Injection sequence ───────────────────────────────────────────────────

    // Load Mermaid first; inject our viewer only once Mermaid, the icon, and
    // the resolved config are all ready.
    injectScript(mermaidUrl, () => {
        Promise.all([iconReady, configReady]).then(() => injectScript(pageUrl));
    });

})();