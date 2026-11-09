// Only literal paragraphs whose HTML representation can be restored exactly.
// Studio's uniform editor-paragraph form is recorded in
// experiments/studio_writeback/evidence/report.json. No other attributes qualify.
const text = /^[\p{L}\p{N} ,.!?;:’“”'\-]+$/u;
function literal(value) {
  return text.test(value) && value.trim() === value &&
    !/^(?:-(?: |$)|\d+[.)](?: |$))/u.test(value) && !/^(?:- *){3,}$/u.test(value);
}
function paragraphs(html) {
  if (typeof html !== "string" || !html) return null;
  const matches = [...html.matchAll(/<p( class="editor-paragraph")?>([^<]*)<\/p>/g)];
  if (!matches.length || matches.map(m => m[0]).join("") !== html) return null;
  if (matches.some(m => m[1] !== matches[0][1] || !literal(m[2]))) return null;
  return { values: matches.map(m => m[2]), attribute: matches[0][1] || "" };
}
function htmlToMarkdown(html) {
  const parsed = paragraphs(html);
  return parsed ? parsed.values.join("\n\n") + "\n" : null;
}
function markdownToHtml(markdown, originalHtml) {
  if (typeof markdown !== "string" || !markdown.endsWith("\n")) return null;
  const original = originalHtml === undefined ? { attribute: "" } : paragraphs(originalHtml);
  if (!original) return null;
  const values = markdown.slice(0, -1).split("\n\n");
  if (values.some(value => !literal(value))) return null;
  const html = values.map(value => `<p${original.attribute}>${value}</p>`).join("");
  return htmlToMarkdown(html) === markdown ? html : null;
}
module.exports = { htmlToMarkdown, markdownToHtml };
