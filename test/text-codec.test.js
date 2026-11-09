const test = require("node:test");
const assert = require("node:assert/strict");
const { htmlToMarkdown, markdownToHtml } = require("../src/text-codec");

test("strict literal paragraphs round-trip exactly", () => {
  const html = "<p>Hello, café.</p><p>Second paragraph!</p>";
  const markdown = "Hello, café.\n\nSecond paragraph!\n";
  assert.equal(htmlToMarkdown(html), markdown);
  assert.equal(markdownToHtml(markdown), html);
});
test("reject ambiguous formatting and noncanonical representations", () => {
  for (const html of ["<p>A &amp; B</p>", "<p><strong>Bold</strong></p>", "<p></p>", "<p> a</p>"]) assert.equal(htmlToMarkdown(html), null);
  for (const md of ["# Heading\n", "**bold**\n", "hello\nworld\n", "hello", "a & b\n", "a\n\n\n"]) assert.equal(markdownToHtml(md), null);
});


test("refuses Markdown blocks despite literal punctuation allowlist", () => {
  for (const value of ["- item", "-", "1.", "1. item", "123) item", "---", "----", "-- -", "- - -"]) {
    assert.equal(markdownToHtml(value + "\n"), null);
    assert.equal(htmlToMarkdown(`<p>${value}</p>`), null);
    assert.equal(htmlToMarkdown(`<p class="editor-paragraph">${value}</p>`), null);
  }
});

test("checked-in Studio paragraph evidence round-trips with source form", () => {
  const report = require('../experiments/studio_writeback/evidence/report.json');
  const found = [];
  function visit(value) {
    if (typeof value === 'string' && value.startsWith('<p class="editor-paragraph">') && htmlToMarkdown(value) !== null) found.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(report);
  assert.ok(found.length > 0, 'existing Studio evidence must contain a supported normalized paragraph');
  for (const html of found) assert.equal(markdownToHtml(htmlToMarkdown(html), html), html);
  const original = '<p class="editor-paragraph">Original</p>';
  assert.equal(markdownToHtml('Edited\n', original), '<p class="editor-paragraph">Edited</p>');
  for (const html of ['<p>Hello</p><p class="editor-paragraph">World</p>', '<p class="editor-paragraph" dir="auto">Hello</p>', '<p class="editor-paragraph"><br></p>']) {
    assert.equal(htmlToMarkdown(html), null);
    assert.equal(markdownToHtml('Edited\n', html), null);
  }
});
