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
  for (const html of ["<p class=\"editor-paragraph\">Hello</p>", "<p>A &amp; B</p>", "<p><strong>Bold</strong></p>", "<p></p>", "<p> a</p>"]) assert.equal(htmlToMarkdown(html), null);
  for (const md of ["# Heading\n", "**bold**\n", "hello\nworld\n", "hello", "a & b\n", "a\n\n\n"]) assert.equal(markdownToHtml(md), null);
});
