/**
 * GFM-oriented Markdown → safe HTML renderer for Zephyr notes / AI / remarks.
 * No raw HTML passthrough. Escapes text; allows only generated tags.
 *
 * Supports: ATX headings, paragraphs, emphasis, strong, del, inline code,
 * links, images, autolinks, fenced/indented code, nested lists, task lists,
 * blockquotes (nested), GFM tables, thematic breaks, hard breaks.
 */

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function safeHref(url = '') {
    const value = String(url || '').trim();
    if (!value) return '';
    // Allow common app / web schemes used by Zephyr notes.
    if (/^(https?:|mailto:|tel:|ssh:|telnet:|jms:|ftp:|\/|#|blob:)/i.test(value)) return value;
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(value)) return value;
    return '';
}

function normalizeNewlines(src) {
    return String(src || '').replace(/\r\n?/g, '\n');
}

/** Inline: code, images, links, autolinks, strong/em/del, br */
function renderInline(text, options = {}) {
    let s = String(text || '');
    const placeholders = [];
    const hold = (html) => {
        const token = `\uE000${placeholders.length}\uE001`;
        placeholders.push(html);
        return token;
    };

    // Inline code first (protect contents from further markdown).
    s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));

    // Images ![alt](url "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g, (_, alt, url, t1, t2) => {
        const href = safeHref(url);
        if (!href) return escapeHtml(alt || '');
        const title = t1 || t2 || '';
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        return hold(`<img class="md-image" src="${escapeAttr(href)}" alt="${escapeAttr(alt)}"${titleAttr} loading="lazy">`);
    });

    // Links [text](url "title")
    s = s.replace(/\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g, (_, label, url, t1, t2) => {
        const href = safeHref(url);
        const inner = renderInline(label, { ...options, nested: true });
        if (!href) return inner;
        const title = t1 || t2 || '';
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        const isApp = /^(ssh:|telnet:|jms:)/i.test(href);
        const target = isApp || href.startsWith('#') || href.startsWith('/')
            ? ''
            : ' target="_blank" rel="noopener noreferrer"';
        return hold(`<a href="${escapeAttr(href)}"${titleAttr}${target}>${inner}</a>`);
    });

    // Autolinks <https://...> or <mailto:...>
    s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, (_, url) => {
        const href = safeHref(url);
        if (!href) return escapeHtml(url);
        return hold(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url.replace(/^mailto:/i, ''))}</a>`);
    });

    // Bare URLs (GFM autolink lite) — only http(s)
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?"')\]])/g, (_, pre, url) => {
        const href = safeHref(url);
        if (!href) return pre + escapeHtml(url);
        return `${pre}${hold(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)}`;
    });

    // Escape remaining HTML-sensitive chars before emphasis.
    s = escapeHtml(s);

    // Strikethrough ~~text~~
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

    // Strong+em ***text*** or ___text___
    s = s.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>');
    // Strong **text** or __text__
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
    // Em *text* or _text_ (avoid matching mid-word underscores roughly)
    s = s.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '<em>$2</em>');

    // Hard line break: two trailing spaces or backslash before newline (already split by block)
    // Soft break within a paragraph is handled by caller as <br> when needed.

    // Restore placeholders (which may themselves contain escaped content).
    s = s.replace(/\uE000(\d+)\uE001/g, (_, i) => placeholders[Number(i)] || '');
    return s;
}

function isBlank(line) {
    return !String(line || '').trim();
}

function isHr(line) {
    return /^\s{0,3}((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})\s*$/.test(line || '');
}

function isAtxHeading(line) {
    return /^(#{1,6})(?:\s+|$)(.*)$/.exec(line || '');
}

function isFenceOpen(line) {
    return /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line || '');
}

function isBlockquote(line) {
    return /^\s{0,3}>\s?(.*)$/.exec(line || '');
}

function isUlItem(line) {
    return /^(\s*)([-*+])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line || '');
}

function isOlItem(line) {
    return /^(\s*)(\d{1,9})([.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line || '');
}

function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line || '');
}

function splitTableRow(line) {
    let s = String(line || '').trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
}

function tableAligns(sepLine) {
    return splitTableRow(sepLine).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
    });
}

function indentWidth(line) {
    const m = /^(\s*)/.exec(line || '');
    if (!m) return 0;
    // Tabs count as 4.
    return m[1].replace(/\t/g, '    ').length;
}

function unwrapTightParagraph(html) {
    const trimmed = String(html || '').trim();
    const m = /^<p>([\s\S]*)<\/p>$/.exec(trimmed);
    if (m && !/<p[\s>]/i.test(m[1])) return m[1];
    return trimmed;
}

function parseList(lines, start, baseIndent, options = {}) {
    const firstUl = isUlItem(lines[start]);
    const firstOl = isOlItem(lines[start]);
    const first = firstUl || firstOl;
    if (!first) return null;
    const ordered = !!firstOl;
    const startNum = ordered ? Number(first[2]) : null;
    const items = [];
    let i = start;

    while (i < lines.length) {
        const ul = isUlItem(lines[i]);
        const ol = isOlItem(lines[i]);
        const item = ordered ? ol : ul;
        if (!item) break;
        const ind = indentWidth(lines[i]);
        if (ind < baseIndent) break;
        if (ind > baseIndent) break; // nested handled inside item

        const checkbox = ordered ? item[4] : item[3];
        const text = ordered ? item[5] : item[4];
        const isTask = checkbox !== undefined;
        const taskChecked = isTask && /x/i.test(checkbox);
        const itemText = text || '';

        i += 1;
        const bodyLines = [itemText];
        // Continuation lines + nested blocks
        while (i < lines.length) {
            if (isBlank(lines[i])) {
                // Lookahead: blank then still indented content continues the item
                let j = i + 1;
                while (j < lines.length && isBlank(lines[j])) j += 1;
                if (j < lines.length && indentWidth(lines[j]) > baseIndent) {
                    bodyLines.push('');
                    i += 1;
                    continue;
                }
                break;
            }
            const contIndent = indentWidth(lines[i]);
            const nextUl = isUlItem(lines[i]);
            const nextOl = isOlItem(lines[i]);
            if ((nextUl || nextOl) && contIndent <= baseIndent) break;
            if (contIndent > baseIndent || nextUl || nextOl || isBlockquote(lines[i]) || isFenceOpen(lines[i])) {
                // strip one level of indent if present
                const stripped = lines[i].replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), '');
                bodyLines.push(stripped);
                i += 1;
                continue;
            }
            // Same-indent non-list: lazy continuation
            if (contIndent === baseIndent && !isAtxHeading(lines[i]) && !isHr(lines[i])) {
                bodyLines.push(lines[i].trim());
                i += 1;
                continue;
            }
            break;
        }

        const loose = bodyLines.some(isBlank);
        let inner = renderBlocks(bodyLines.join('\n'), options);
        if (!loose) inner = unwrapTightParagraph(inner);
        items.push({ isTask, taskChecked, html: inner });
    }

    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && startNum && startNum !== 1 ? ` start="${startNum}"` : '';
    const className = items.some((it) => it.isTask) ? ' class="md-task-list"' : '';
    const html = `<${tag}${startAttr}${className}>${items.map((it) => {
        if (it.isTask) {
            const box = `<input type="checkbox" disabled${it.taskChecked ? ' checked' : ''}> `;
            return `<li class="task">${box}${it.html}</li>`;
        }
        return `<li>${it.html}</li>`;
    }).join('')}</${tag}>`;

    return { html, next: i };
}

function parseBlockquote(lines, start, options = {}) {
    const qLines = [];
    let i = start;
    while (i < lines.length) {
        const m = isBlockquote(lines[i]);
        if (m) {
            qLines.push(m[1]);
            i += 1;
            continue;
        }
        // lazy continuation
        if (!isBlank(lines[i]) && !isAtxHeading(lines[i]) && !isHr(lines[i]) && !isFenceOpen(lines[i]) && !isUlItem(lines[i]) && !isOlItem(lines[i])) {
            qLines.push(lines[i]);
            i += 1;
            continue;
        }
        break;
    }
    return { html: `<blockquote>${renderBlocks(qLines.join('\n'), options)}</blockquote>`, next: i };
}

function parseFence(lines, start, options = {}) {
    const open = isFenceOpen(lines[start]);
    if (!open) return null;
    const marker = open[2][0];
    const markerLen = open[2].length;
    const info = String(open[3] || '').trim();
    const lang = (info.split(/\s+/)[0] || '').replace(/[^a-zA-Z0-9_+#.-]/g, '');
    const body = [];
    let i = start + 1;
    while (i < lines.length) {
        const close = new RegExp(`^\\s{0,3}${marker}{${markerLen},}\\s*$`).exec(lines[i]);
        if (close) {
            i += 1;
            break;
        }
        body.push(lines[i]);
        i += 1;
    }
    const code = body.join('\n');
    if (typeof options.renderCodeBlock === 'function') {
        try {
            return { html: options.renderCodeBlock(code, info, lang), next: i };
        } catch (_) { /* fall through */ }
    }
    const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : '';
    const dataLang = lang ? ` data-lang="${escapeAttr(lang)}"` : '';
    return {
        html: `<pre class="md-code"${dataLang}><code${langClass}>${escapeHtml(code)}</code></pre>`,
        next: i,
    };
}

function parseIndentedCode(lines, start) {
    if (!/^(?: {4}|\t)/.test(lines[start] || '')) return null;
    if (isBlank(lines[start])) return null;
    // Don't steal list continuations
    if (isUlItem(lines[start]) || isOlItem(lines[start])) return null;
    const body = [];
    let i = start;
    while (i < lines.length) {
        if (/^(?: {4}|\t)/.test(lines[i])) {
            body.push(lines[i].replace(/^(?: {4}|\t)/, ''));
            i += 1;
            continue;
        }
        if (isBlank(lines[i])) {
            // keep blank inside code if next is still indented
            let j = i + 1;
            while (j < lines.length && isBlank(lines[j])) j += 1;
            if (j < lines.length && /^(?: {4}|\t)/.test(lines[j])) {
                body.push('');
                i += 1;
                continue;
            }
        }
        break;
    }
    if (!body.length) return null;
    return {
        html: `<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`,
        next: i,
    };
}

function parseTable(lines, start) {
    if (start + 1 >= lines.length) return null;
    if (!lines[start].includes('|')) return null;
    if (!isTableSep(lines[start + 1])) return null;
    // Avoid matching only one pipe without real table
    if (!/\|/.test(lines[start + 1])) return null;

    const heads = splitTableRow(lines[start]);
    const aligns = tableAligns(lines[start + 1]);
    let i = start + 2;
    const rows = [];
    while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i]) && !isHr(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
    }
    const alignAttr = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '');
    const thead = `<thead><tr>${heads.map((h, idx) => `<th${alignAttr(idx)}>${renderInline(h)}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${rows.map((r) => `<tr>${heads.map((_, idx) => `<td${alignAttr(idx)}>${renderInline(r[idx] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
    return {
        html: `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`,
        next: i,
    };
}

function paragraphLinesToHtml(paraLines) {
    // Hard breaks: line ending with two spaces or backslash
    const parts = paraLines.map((line, idx) => {
        const hard = / {2}$/.test(line) || /\\$/.test(line);
        const cleaned = line.replace(/ {2}$/, '').replace(/\\$/, '');
        const html = renderInline(cleaned);
        if (idx < paraLines.length - 1) return hard ? `${html}<br>\n` : `${html}\n`;
        return html;
    });
    // Join soft breaks as spaces for normal paragraphs (GFM-ish: single newline → space)
    // But we already inserted \n; convert lone newlines between to space except after <br>
    let joined = parts.join('');
    joined = joined.replace(/([^>])\n(?!\n)/g, '$1 ');
    return `<p>${joined.trim()}</p>`;
}

function renderBlocks(src, options = {}) {
    const lines = normalizeNewlines(src).split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
        if (isBlank(lines[i])) {
            i += 1;
            continue;
        }

        // Fenced code
        if (isFenceOpen(lines[i])) {
            const fence = parseFence(lines, i, options);
            if (fence) {
                out.push(fence.html);
                i = fence.next;
                continue;
            }
        }

        // ATX heading
        const heading = isAtxHeading(lines[i]);
        if (heading) {
            const level = Math.min(6, heading[1].length);
            const text = heading[2].replace(/\s+#+\s*$/, '').trim();
            out.push(`<h${level}>${renderInline(text)}</h${level}>`);
            i += 1;
            continue;
        }

        // Thematic break
        if (isHr(lines[i])) {
            out.push('<hr>');
            i += 1;
            continue;
        }

        // Table
        const table = parseTable(lines, i);
        if (table) {
            out.push(table.html);
            i = table.next;
            continue;
        }

        // Blockquote
        if (isBlockquote(lines[i])) {
            const bq = parseBlockquote(lines, i, options);
            out.push(bq.html);
            i = bq.next;
            continue;
        }

        // Lists
        if (isUlItem(lines[i]) || isOlItem(lines[i])) {
            const ind = indentWidth(lines[i]);
            const list = parseList(lines, i, ind, options);
            if (list) {
                out.push(list.html);
                i = list.next;
                continue;
            }
        }

        // Indented code
        const indented = parseIndentedCode(lines, i);
        if (indented) {
            out.push(indented.html);
            i = indented.next;
            continue;
        }

        // Paragraph
        const para = [];
        while (i < lines.length && !isBlank(lines[i])) {
            if (isAtxHeading(lines[i]) || isHr(lines[i]) || isFenceOpen(lines[i])) break;
            if (isBlockquote(lines[i])) break;
            if (isUlItem(lines[i]) || isOlItem(lines[i])) break;
            if (lines[i].includes('|') && isTableSep(lines[i + 1] || '')) break;
            para.push(lines[i]);
            i += 1;
        }
        if (para.length) out.push(paragraphLinesToHtml(para));
    }

    return out.join('\n') || '';
}

/**
 * @param {string} md
 * @param {{ renderCodeBlock?: (code: string, info: string, lang: string) => string }} [options]
 * @returns {string} HTML
 */
export function renderMarkdown(md, options = {}) {
    try {
        return renderBlocks(String(md ?? ''), options);
    } catch (err) {
        console.warn('[markdown] render failed', err);
        return `<p>${escapeHtml(md)}</p>`;
    }
}

export function renderInlineMarkdown(text) {
    return renderInline(text);
}

export { escapeHtml, escapeAttr, safeHref };

// Browser global for notes.js / legacy callers
try {
    if (typeof window !== 'undefined') {
        window.renderMarkdown = renderMarkdown;
        window.renderInlineMarkdown = renderInlineMarkdown;
    }
} catch (_) {}

export default renderMarkdown;
