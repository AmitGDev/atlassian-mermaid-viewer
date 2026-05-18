/**
 * mermaid-page.js
 *
 * Runs in the PAGE context (not Chrome's isolated content-script world).
 * Injected by mermaid-viewer.js via a <script src="chrome-extension://..."> tag,
 * which Confluence's CSP explicitly allows.
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

    // ─── Panel creation ───────────────────────────────────────────────────────

    /**
     * Renders the Mermaid diagram into the given container and attaches the toolbar.
     * Shows a "Rendering…" placeholder while mermaid.render() is in flight.
     * On success, corrects v11's SVG sizing so small diagrams render at their natural
     * width and large ones shrink to fit the container.
     * On failure, displays the error message in place of the diagram.
     * @param {string} codeText       - Raw Mermaid diagram source.
     * @param {HTMLElement} container - The .mermaid-content div that hosts the output.
     */
    async function createPanel(codeText, container) {
        container.innerHTML = '<em style="color:#888; font-size:12px;">Rendering…</em>';

        try {
            const id = 'mermaid-' + Math.random().toString(36).substr(2, 7);
            const { svg } = await mermaid.render(id, codeText);
            container.innerHTML = svg;

            // Remove phantom whitespace text nodes left by mermaid.render().
            // They create a spurious gap at the bottom of the container.
            // Safe to remove - text nodes have no effect on SVG rendering.
            Array.from(container.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .forEach(n => n.remove());

            const svgEl = container.querySelector('svg');
            if (svgEl) {
                svgEl.removeAttribute('height');

                // Mermaid sets width="100%" + inline style="max-width: Xpx" (the natural
                // diagram width). Promote that natural cap to a fixed width attribute so the
                // CSS max-width:100% rule only clips it when it genuinely overflows - small
                // diagrams render at their natural size, large ones shrink to fit.
                const naturalMaxWidth = svgEl.style.maxWidth;
                if (naturalMaxWidth) {
                    svgEl.setAttribute('width', naturalMaxWidth);
                    svgEl.style.removeProperty('max-width');
                }
            }
        } catch (e) {
            container.innerHTML = `<pre style="color:red; margin:0;">${e.message}</pre>`;
        }

        container.appendChild(createToolbar(codeText));
    }

    // ─── DOM scanning ─────────────────────────────────────────────────────────

    /**
     * Scans for Confluence code blocks containing Mermaid diagrams and replaces
     * each with a rendered panel.
     *
     * Confluence Cloud renders code blocks as <code class="language-..."> with
     * per-line <span> children - not the classic <pre><code> pattern.
     * `data-mermaid-processed` guards against double-processing on repeated calls.
     */
    function processBlocks() {
        document.querySelectorAll('code[class^="language-"]').forEach(block => {
            if (block.closest('[data-mermaid-processed]')) return;

            const text = block.textContent.trim();
            if (!isMermaid(text)) return;

            const container = document.createElement('div');
            container.setAttribute('data-mermaid-processed', 'true');
            container.className = 'mermaid-content';

            // Replace the full Confluence .code-block wrapper so its gray background
            // and padding don't bleed through beneath the rendered panel.
            const codeBlock = block.closest('.code-block') || block.closest('pre') || block;
            codeBlock.replaceWith(container);
            createPanel(text, container);
        });
    }

    processBlocks();

    // ─── MutationObserver (SPA navigation) ───────────────────────────────────

    /**
     * Confluence is a React SPA - page content loads incrementally after navigation.
     *
     * Two subtleties:
     *  1. SELF-TRIGGER: container mutations (our own innerHTML writes) fire the
     *     observer. Filter them out by checking m.target against our containers.
     *  2. RACE CONDITION: Confluence renders content in batches. Debounce by 300ms
     *     so we scan only after the DOM has settled.
     */
    let debounceTimer;
    new MutationObserver((mutations) => {
        const relevant = mutations.some(m => !m.target.closest('[data-mermaid-processed]'));
        if (!relevant) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(processBlocks, 300);
    }).observe(document.body, { childList: true, subtree: true });

})();