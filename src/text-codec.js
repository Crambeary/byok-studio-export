// Deliberately narrow: literal paragraphs with no Markdown or HTML syntax.
// Returning null means that the conversion has not been proved reversible.
const text = /^[\p{L}\p{N} ,.!?;:’“”'\-]+$/u;
function htmlToMarkdown(html) {
  if (typeof html !== "string" || !html) return null;
  const paragraphs = html.match(/<p>[^<]*<\/p>/g);
  if (!paragraphs || paragraphs.join("") !== html) return null;
  const values = paragraphs.map(p => p.slice(3, -4));
  if (values.some(value => !text.test(value) || value.trim() !== value)) return null;
  return values.join("\n\n") + "\n";
}
function markdownToHtml(markdown) {
  if (typeof markdown !== "string" || !markdown.endsWith("\n")) return null;
  const values = markdown.slice(0, -1).split("\n\n");
  if (values.some(value => !text.test(value) || value.trim() !== value)) return null;
  const html = values.map(value => `<p>${value}</p>`).join("");
  return htmlToMarkdown(html) === markdown ? html : null;
}
module.exports = { htmlToMarkdown, markdownToHtml };
