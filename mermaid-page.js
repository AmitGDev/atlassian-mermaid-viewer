/**
 * mermaid-page.js
 *
 * Runs in the PAGE context (not the browser's isolated content-script world).
 * Injected by mermaid-viewer.js via a <script src="<extension-url>..."> tag
 * (chrome-extension:// on Chrome/Edge, moz-extension:// on Firefox),
 * which Confluence's CSP explicitly allows on all supported browsers.
 *
 * Responsibilities:
 *  - Scan the page for Confluence code blocks containing Mermaid syntax
 *  - Replace each block with a rendered chart + hover icon toolbar
 *  - Watch for dynamically loaded content (Confluence is a React SPA) via MutationObserver
 */
(function () {
    'use strict';

    // ─── Styles ───────────────────────────────────────────────────────────────

    /**
     * Inject a <style> tag into the page.
     * CSP note: Confluence blocks inline <script> but NOT <style> tags.
     */
    const style = document.createElement('style');
    style.textContent = `
        /* Replaces the original code block and hosts the chart.
        Functional:
        - width: 100% + max-width: none: stretch to fill the Confluence content column;
            Confluence caps content elements with its own max-width which would otherwise
            clip wide diagrams.
        - box-sizing: border-box: prevents the 16px padding from adding to the declared
            width and causing horizontal overflow.
        - position: relative: anchors the absolutely-positioned toolbar.
        - line-height: normal: Confluence's inherited line-height leaks into the container
            and affects Mermaid's node size pre-calculations.
        Aesthetic:
        - border, border-radius: card-style frame around the diagram.
        - padding: breathing room between the diagram and the card edge.
        - margin-bottom: separation from the next content block. */
        .mermaid-content {
            width: 100% !important;
            max-width: none !important;
            box-sizing: border-box !important;
            position: relative;
            line-height: normal !important;
            border: 1px solid var(--ds-border, #dfe1e6);
            border-radius: 4px;
            padding: 16px;
            margin-bottom: 8px;
        }

        /* SVG sizing and alignment.
        - max-width: 100% + height: auto: cap diagrams wider than the container
            while preserving aspect ratio. Without this, wide diagrams overflow
            horizontally.
        - display: block: SVG is inline by default, which leaves a phantom gap
            at the bottom of the container (inline elements sit on the text baseline,
            reserving descender space below). Block eliminates that gap.
        - margin: 0 auto: centers small diagrams that are narrower than the
            container. Without it they sit left-aligned. */
        .mermaid-content > svg {
            max-width: 100% !important;
            height: auto !important;
            display: block !important;
            margin: 0 auto;
        }

        /* Labels rendered inside <foreignObject> divs, so Confluence's
        full CSS cascade applies - overriding font-size, line-height, and font-family
        and causing text to overflow pre-calculated bounding boxes. Node labels are
        direct children (foreignObject > div), edge labels (Yes/No etc.) nest deeper
        (foreignObject > div > p). Use a descendant selector (*) with "all: revert"
        to strip all inherited Confluence styles and revert to user-agent stylesheet
        values across all nesting levels. */
        .mermaid-content svg foreignObject * {
           all: revert;
        }

        /* Confluence's div rules override Mermaid's inline flex centering on foreignObject
        divs, collapsing the layout to block and pushing text to the top-left of the node.
        Functional:
        - display: flex: restores what Confluence collapsed; without it the remaining
            properties have no effect.
        - align-items: center: vertically centers the label within the node box.
        - justify-content: center: horizontally centers the label; without it text
            sits left-aligned inside the node.
        - height: 100%: stretches the div to the full foreignObject height so
            align-items has space to center within; without it the div shrinks to
            content height and vertical centering has nothing to work against. */
        .mermaid-content svg foreignObject > div {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            height: 100% !important;
        }

        /* ── Hover toolbar ────────────────────────────────────────── */

        .mermaid-toolbar {
            position: absolute;
            top: 8px;
            right: 8px;
            display: flex;
            gap: 4px;
            opacity: 0;
            transition: opacity 0.2s ease;
            z-index: 10;
        }
        .mermaid-content:hover .mermaid-toolbar {
            opacity: 0.5;
        }

        .mermaid-toolbar button {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            padding: 0;
            background: transparent;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            color: #42526e;
            transition: background 0.15s ease;
        }
        .mermaid-toolbar button:hover {
            background: rgba(9, 30, 66, 0.1);
        }

        @media (prefers-color-scheme: dark) {
            .mermaid-toolbar button {
                color: #b8c7e0;
            }
            .mermaid-toolbar button:hover {
                background: rgba(255, 255, 255, 0.1);
            }
        }

        /* Toolbar icon SVGs must not inherit the diagram SVG rules above */
        .mermaid-toolbar button svg {
            width: 16px !important;
            height: 16px !important;
            max-width: none !important;
            display: block !important;
            flex-shrink: 0;
        }
    `;
    document.head.appendChild(style);

    // ─── Mermaid init ─────────────────────────────────────────────────────────

    /**
     * Initialise Mermaid.
     */
    mermaid.initialize({
        // We call mermaid.render() directly - don't let Mermaid scan the page itself.
        startOnLoad: false,

        // "securityLevel: 'strict'" is used to prevent HTML injection in node labels.
        // In strict mode, tags such as <br/> are rendered as plain text instead of being interpreted as HTML.
        //
        // We intentionally avoid 'loose' mode because it enables raw HTML rendering inside labels,
        // which increases XSS risk when diagram content is not fully sanitized.
        //
        // Although current input originates from Confluence page editors (trusted source),
        // we still treat it as untrusted until proper sanitization is implemented.
        //
        // Switching to 'loose' mode was considered and deliberately rejected (see AMV-28).
        // The complexity of input and output sanitization required to do so safely
        // was not justified by the formatting benefit (<br/>, bold, italic in labels).
        // This decision should not be revisited without a concrete user requirement
        // and a dedicated sanitization ticket.
        securityLevel: 'strict',

        look: 'handDrawn'
    });

    // ─── Diagram detection ────────────────────────────────────────────────────

    const MERMAID_STARTERS = [
        'graph ', 'flowchart ', 'sequenceDiagram', 'classDiagram',
        'erDiagram', 'gantt', 'pie ', 'stateDiagram', 'gitGraph'
    ];

    /**
     * Returns true if the given text looks like a Mermaid diagram.
     * Matches against known diagram-type keywords that must appear at the start.
     * @param {string} text - Trimmed text content of a code block.
     */
    function isMermaid(text) {
        return MERMAID_STARTERS.some(s => text.startsWith(s));
    }

    // ─── Icon SVGs ────────────────────────────────────────────────────────────

    // Mermaid Live: inline SVG with brand pink - no asset load required
    const SVG_MERMAID = document.documentElement.dataset.mermaidIconSvg;

    // Copy icon: two overlapping rectangles - currentColor adapts to light/dark
    const SVG_COPY = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;

    // Checkmark: shown briefly after a successful copy - green is intentional feedback
    const SVG_CHECK = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 12l5 5L20 7" stroke="#4caf50" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    // ─── Actions ──────────────────────────────────────────────────────────────

    /**
     * Opens the given Mermaid diagram source in Mermaid Live editor in a new tab.
     * The code is base64-encoded into the URL hash so Mermaid Live loads it directly.
     * Each call opens a fresh tab - intentional, so previous edits are never overwritten.
     * @param {string} code - Raw Mermaid diagram source.
     */
    function openInMermaidLive(code) {
        const state = JSON.stringify({ code, mermaid: { theme: 'default' } });
        const encoded = btoa(unescape(encodeURIComponent(state)));
        window.open(`https://mermaid.live/edit#base64:${encoded}`, '_blank');
    }

    // ─── Toolbar ──────────────────────────────────────────────────────────────

    /**
     * Builds the hover toolbar with two icon buttons:
     *  - Left: Open in Mermaid Live (primary action)
     *  - Right: Copy code to clipboard, with a brief checkmark confirmation
     * The toolbar is appended to the container and revealed via CSS on hover.
     * @param {string} codeText - Raw Mermaid diagram source to act on.
     * @returns {HTMLElement} The toolbar div, ready to be appended.
     */
    function createToolbar(codeText) {
        const toolbar = document.createElement('div');
        toolbar.className = 'mermaid-toolbar';

        // Left: Open in Mermaid Live
        const liveBtn = document.createElement('button');
        liveBtn.title = 'Open in Mermaid Live';
        liveBtn.innerHTML = SVG_MERMAID;
        liveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openInMermaidLive(codeText);
        });

        // Right: Copy code
        const copyBtn = document.createElement('button');
        copyBtn.title = 'Copy code';
        copyBtn.innerHTML = SVG_COPY;
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(codeText).then(() => {
                copyBtn.innerHTML = SVG_CHECK;
                setTimeout(() => { copyBtn.innerHTML = SVG_COPY; }, 1500);
            });
        });

        toolbar.appendChild(liveBtn);
        toolbar.appendChild(copyBtn);
        return toolbar;
    }

    // ─── Render cache ─────────────────────────────────────────────────────────

    /**
     * Caches rendered SVG strings keyed by diagram source.
     * Prevents redundant Mermaid parse/render cycles for identical diagrams,
     * which is common during Confluence SPA navigation (same diagrams reload).
     *
     * Eviction: oldest-first when the cache reaches RENDER_CACHE_MAX entries.
     * Map preserves insertion order, so keys().next() always yields the oldest key.
     */
    const RENDER_CACHE_MAX = 100;
    const renderCache = new Map();

    // ─── SVG insertion ────────────────────────────────────────────────────────

    /**
     * Parses an SVG string safely via DOMParser and inserts it into the container.
     *
     * Why DOMParser instead of innerHTML:
     *  - Parses as XML (image/svg+xml), avoiding HTML parser ambiguities.
     *  - Produces a deterministic DOM structure with no phantom text nodes.
     *  - DOMParser signals malformed input via a <parsererror> root - detectable
     *    and catchable, unlike innerHTML which silently mangles bad markup.
     *
     * document.adoptNode() transfers the SVG element from the DOMParser's
     * detached document into the page document before insertion, making
     * ownership explicit and avoiding cross-document reference edge cases.
     *
     * SVG sizing corrections (Mermaid v11):
     *  - Remove height attribute: lets CSS control height via aspect ratio.
     *  - Promote inline max-width to a width attribute: CSS max-width:100% then
     *    only clips diagrams that genuinely overflow - small diagrams render at
     *    their natural size rather than stretching to fill the container.
     *
     * @param {string}      svgString - Raw SVG markup from mermaid.render().
     * @param {HTMLElement} container - The .mermaid-content div to insert into.
     * @throws {Error} If DOMParser signals a parse error.
     */
    function insertSvg(svgString, container) {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(svgString, 'image/svg+xml');
        const svgEl  = doc.documentElement;

        // DOMParser surfaces XML parse errors as a <parsererror> root element
        // rather than throwing - detect and re-throw so createPanel can catch it.
        if (svgEl.tagName === 'parsererror') {
            throw new Error('Mermaid returned malformed SVG: ' + svgEl.textContent);
        }

        document.adoptNode(svgEl);

        // SVG sizing corrections (see JSDoc above)
        svgEl.removeAttribute('height');
        const naturalMaxWidth = svgEl.style.maxWidth;
        if (naturalMaxWidth) {
            svgEl.setAttribute('width', naturalMaxWidth);
            svgEl.style.removeProperty('max-width');
        }

        // replaceChildren: atomic, produces no phantom text nodes, no need
        // for post-insertion cleanup.
        container.replaceChildren(svgEl);
    }

    // ─── Panel creation ───────────────────────────────────────────────────────

    /**
     * Renders the Mermaid diagram into the given container and attaches the toolbar.
     * Shows a "Rendering…" placeholder while mermaid.render() is in flight.
     *
     * Cache hit:  SVG string retrieved from renderCache, parsed via DOMParser, inserted.
     * Cache miss: mermaid.render() called, result stored in renderCache, then inserted.
     *
     * On failure, displays the error message in place of the diagram.
     * Toolbar injection is idempotent - any existing toolbar is removed before
     * the new one is appended, preventing duplicates on re-renders.
     *
     * @param {string}      codeText  - Raw Mermaid diagram source.
     * @param {HTMLElement} container - The .mermaid-content div that hosts the output.
     */
    async function createPanel(codeText, container) {
        container.innerHTML = '<em style="color:#888; font-size:12px;">Rendering…</em>';

        try {
            let svgString;

            if (renderCache.has(codeText)) {
                svgString = renderCache.get(codeText);
            } else {
                const id = 'mermaid-' + Math.random().toString(36).substr(2, 7);
                ({ svg: svgString } = await mermaid.render(id, codeText));

                // Evict the oldest entry before inserting to keep memory bounded.
                if (renderCache.size >= RENDER_CACHE_MAX) {
                    renderCache.delete(renderCache.keys().next().value);
                }
                renderCache.set(codeText, svgString);
            }

            insertSvg(svgString, container);

        } catch (e) {
            container.innerHTML = `<pre style="color:red; margin:0;">${e.message}</pre>`;
        }

        // Idempotent toolbar: remove any existing instance before appending.
        // Guards against duplicate toolbars if createPanel is called more than once
        // on the same container (e.g. during SPA re-hydration).
        container.querySelector('.mermaid-toolbar')?.remove();
        container.appendChild(createToolbar(codeText));
    }

    // ─── DOM scanning ─────────────────────────────────────────────────────────

    /**
     * Replaces a confirmed Mermaid code block with a rendered panel.
     *
     * Wraps the panel in a .mermaid-content container marked with
     * `data-mermaid-processed` to guard against double-processing.
     * Replaces the full Confluence .code-block wrapper so its gray background
     * and padding don't bleed through beneath the rendered panel.
     * @param {HTMLElement} block    - The <code> element containing the diagram source.
     * @param {string}      codeText - Trimmed textContent of the block.
     */
    function renderBlock(block, codeText) {
        const container = document.createElement('div');
        container.setAttribute('data-mermaid-processed', 'true');
        container.className = 'mermaid-content';

        const codeBlock = block.closest('.code-block') || block.closest('pre') || block;
        codeBlock.replaceWith(container);
        createPanel(codeText, container);
    }

    // ─── Shared pending observer (Stage 2) ───────────────────────────────────

    /**
     * Tracks <code> blocks that were empty when first encountered.
     * The shared pendingWatcher checks this Set on every mutation within the
     * document body and renders any block whose content has since arrived.
     *
     * One observer serves all pending blocks regardless of page size,
     * keeping the total observer count fixed at two for the lifetime of the page.
     */
    const pendingBlocks = new Set();

    const pendingWatcher = new MutationObserver(() => {
        for (const block of pendingBlocks) {
            const text = block.textContent?.trim();
            if (!text) continue;

            pendingBlocks.delete(block);
            block.removeAttribute('data-mermaid-pending');

            if (isMermaid(text)) renderBlock(block, text);
        }
    });

    pendingWatcher.observe(document.body, {
        childList:     true,  // <span> children being appended by React
        characterData: true,  // text node content being written directly
        subtree:       true,  // catch text nodes at any nesting depth
    });

    /**
     * Processes a single candidate <code> block.
     *
     * Two-stage strategy to handle Confluence's React rendering pipeline,
     * which inserts <code> elements before populating their text content:
     *
     *  Stage 1 - Content present: render immediately.
     *  Stage 2 - Empty block: register in pendingBlocks for the shared
     *            pendingWatcher to pick up the moment content arrives.
     *
     * Guards:
     *  - `data-mermaid-processed` (on the replacement container): block has already
     *    been rendered; skip via closest() check.
     *  - `data-mermaid-pending`   (on the <code> element itself): block is already
     *    registered in pendingBlocks; skip to prevent duplicate entries.
     * @param {HTMLElement} block - A <code class="language-..."> element.
     */
    function processCandidate(block) {
        // Already rendered or already queued
        if (block.closest('[data-mermaid-processed]')) return;
        if (block.hasAttribute('data-mermaid-pending'))   return;

        const text = block.textContent.trim();

        if (text) {
            // Stage 1: content is present - validate and render immediately
            if (isMermaid(text)) renderBlock(block, text);
        } else {
            // Stage 2: block is empty - Confluence hasn't populated it yet.
            // Register with the shared pendingWatcher rather than creating a
            // new observer per block.
            block.setAttribute('data-mermaid-pending', 'true');
            pendingBlocks.add(block);
        }
    }

    /**
     * Collects <code class="language-..."> elements from a list of added DOM nodes.
     * Each node may itself be a candidate or may contain candidates as descendants.
     * @param {NodeList|Array} addedNodes
     * @returns {HTMLElement[]}
     */
    function extractCandidates(addedNodes) {
        const candidates = [];
        for (const node of addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches('code[class^="language-"]')) candidates.push(node);
            node.querySelectorAll('code[class^="language-"]').forEach(el => candidates.push(el));
        }
        return candidates;
    }

    // ─── Full-page rescan ─────────────────────────────────────────────────────

    /**
     * Scans the entire document for unprocessed Mermaid code blocks.
     *
     * WHY THIS IS NEEDED alongside the MutationObserver:
     *
     * The MutationObserver only fires for nodes that are ADDED to the DOM
     * (childList mutations). On Confluence edit→save, React may RECONCILE
     * existing DOM nodes rather than replacing them - reusing the same <code>
     * element instances and updating their content in-place. No nodes are
     * added, so no addedNodes mutation fires, and the observer never sees the
     * blocks. A full rescan catches these reconciled-but-unprocessed nodes.
     *
     * Called exclusively on SPA navigation events, not on every DOM mutation,
     * keeping the cost proportional to navigation frequency rather than
     * mutation volume. pendingBlocks is cleared first to evict entries from
     * the previous page whose source nodes may be detached or reused.
     */
    function rescanPage() {
        pendingBlocks.clear();
        document.querySelectorAll('code[class^="language-"]').forEach(processCandidate);
    }

    // ─── Bootstrap ────────────────────────────────────────────────────────────

    // Process any blocks already present in the DOM before the observer attaches.
    document.querySelectorAll('code[class^="language-"]').forEach(processCandidate);

    // ─── MutationObserver (SPA navigation) ───────────────────────────────────

    /**
     * Catches code blocks that arrive as genuinely new DOM nodes - the common
     * case during normal SPA navigation where React mounts fresh content.
     *
     * Observes document.body rather than #main-content: Confluence replaces
     * #main-content on edit→save (React unmounts/remounts the view component),
     * which would silently kill a scoped observer. document.body is never
     * replaced in a SPA and is always a stable observation target.
     *
     * Self-trigger prevention: our own DOM writes (container creation, SVG
     * insertion) never introduce <code class="language-..."> elements, so
     * extractCandidates() naturally returns nothing for those mutations.
     */
    new MutationObserver((mutations) => {
        const added = mutations.flatMap(m => [...m.addedNodes]);
        extractCandidates(added).forEach(processCandidate);
    }).observe(document.body, { childList: true, subtree: true });

    // ─── SPA navigation detection ─────────────────────────────────────────────

    /**
     * Confluence uses React Router, which updates the URL via history.pushState
     * without triggering a browser navigation. On edit→save, the sequence is:
     *
     *   1. User saves → Confluence calls history.pushState (edit URL → view URL)
     *   2. React reconciles the DOM - it may REUSE existing <code> nodes rather
     *      than removing and re-adding them. No childList mutation fires for
     *      those nodes, so the MutationObserver above never sees them.
     *
     * Intercepting pushState ensures a full DOM rescan is scheduled after each
     * navigation, covering reconciled nodes that the observer cannot detect.
     *
     * WHY double requestAnimationFrame:
     * history.pushState fires synchronously BEFORE React has re-rendered.
     * - rAF 1: queued after the current task; React schedules its render here.
     * - rAF 2: fires after React has committed the updated DOM to the screen.
     * A single rAF or setTimeout(0) is not sufficient when React defers its
     * commit to the next paint cycle (concurrent/batched rendering mode).
     *
     * popstate handles browser back/forward navigation over the same routes.
     */
    function onSpaNavigate() {
        requestAnimationFrame(() => requestAnimationFrame(rescanPage));
    }

    // Wrap pushState to intercept React Router navigation
    const _pushState = history.pushState.bind(history);
    history.pushState = function (...args) {
        _pushState(...args);
        onSpaNavigate();
    };

    // Handle browser back/forward buttons
    window.addEventListener('popstate', onSpaNavigate);

})();