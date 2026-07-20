import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { renderMarkdown, renderInlineMarkdown } = await import(
    pathToFileURL(join(root, 'public/markdown.js')).href
);

const notesJs = readFileSync(join(root, 'public/notes.js'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');

test('headings h1-h6 and thematic break', () => {
    const html = renderMarkdown('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n\n---\n');
    assert.match(html, /<h1>H1<\/h1>/);
    assert.match(html, /<h6>H6<\/h6>/);
    assert.match(html, /<hr>/);
});

test('emphasis strong em del and inline code', () => {
    const html = renderMarkdown('**bold** and *em* and ~~strike~~ and `code`');
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>em<\/em>/);
    assert.match(html, /<del>strike<\/del>/);
    assert.match(html, /<code>code<\/code>/);
});

test('links images and autolinks', () => {
    const html = renderMarkdown('[x](https://example.com) ![a](https://img.test/a.png) <https://a.com>');
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /src="https:\/\/img\.test\/a\.png"/);
    assert.match(html, /href="https:\/\/a\.com"/);
});

test('blocks unsafe javascript urls', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    assert.doesNotMatch(html, /javascript:/i);
});

test('fenced code with language', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```');
    assert.match(html, /language-js/);
    assert.match(html, /const a = 1;/);
    assert.doesNotMatch(html, /<script/i);
});

test('escapes raw html in source', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nHello <b>x</b>');
    assert.doesNotMatch(html, /<script>/i);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('unordered ordered and task lists', () => {
    const html = renderMarkdown('- a\n- b\n\n1. one\n2. two\n\n- [ ] todo\n- [x] done\n');
    assert.match(html, /<ul>[\s\S]*<li>a<\/li>/);
    assert.match(html, /<ol>[\s\S]*<li>one<\/li>/);
    assert.match(html, /class="task"/);
    assert.match(html, /type="checkbox"[^>]*checked/);
});

test('nested lists', () => {
    const html = renderMarkdown('- parent\n  - child\n  - child2\n- next\n');
    assert.match(html, /<ul>[\s\S]*child[\s\S]*<\/ul>/);
});

test('blockquotes nested', () => {
    const html = renderMarkdown('> outer\n> > inner\n');
    assert.match(html, /<blockquote>[\s\S]*<blockquote>/);
});

test('gfm tables with alignment', () => {
    const html = renderMarkdown('| A | B |\n| :--- | ---: |\n| 1 | 2 |\n');
    assert.match(html, /md-table/);
    assert.match(html, /<th[^>]*>A<\/th>/);
    assert.match(html, /text-align:left/);
    assert.match(html, /text-align:right/);
    assert.match(html, /<td[^>]*>1<\/td>/);
});

test('hard line breaks', () => {
    const html = renderMarkdown('line1  \nline2');
    assert.match(html, /line1<br>/);
    assert.match(html, /line2/);
});

test('ssh deeplink preserved for notes', () => {
    const html = renderMarkdown('[host](ssh://root@1.2.3.4:22)');
    assert.match(html, /href="ssh:\/\/root@1\.2\.3\.4:22"/);
});

test('renderCodeBlock option used by AI path', () => {
    const html = renderMarkdown('```html\n<b>x</b>\n```', {
        renderCodeBlock: (code, info) => `<div class="ai-wrap" data-info="${info}">${code.length}</div>`,
    });
    assert.match(html, /ai-wrap/);
    assert.match(html, />\d+</);
});

test('inline renderer independent', () => {
    assert.match(renderInlineMarkdown('**x**'), /<strong>x<\/strong>/);
});

test('notes imports full markdown module', () => {
    assert.match(notesJs, /from '\.\/markdown\.js\?v=20260720-notes-md1'/);
    assert.match(notesJs, /renderMarkdownFull|renderMarkdown as renderMarkdownFull/);
    assert.match(notesJs, /function refreshPreview/);
    assert.match(notesJs, /schedulePreviewRefresh/);
    // Old incomplete regex fallback must not be the primary path.
    assert.doesNotMatch(notesJs, /text\.replace\(\/\^### \(\.\+\)\$\/gm/);
});

test('app.js uses shared markdown core', () => {
    assert.match(appJs, /from '\.\/markdown\.js\?v=20260720-notes-md1'/);
    assert.match(appJs, /renderMarkdownCore/);
    assert.match(appJs, /window\.renderMarkdown = renderMarkdown/);
});

test('notes preview styles cover tables tasks images hr', () => {
    assert.match(styleCss, /\.notes-preview \.md-table-wrap/);
    assert.match(styleCss, /\.notes-preview li\.task/);
    assert.match(styleCss, /\.notes-preview img/);
    assert.match(styleCss, /\.notes-preview hr/);
    assert.match(styleCss, /\.notes-preview h4/);
});
