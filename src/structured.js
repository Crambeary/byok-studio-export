// Read-only projection of the shapes captured in experiments/structured_import.
function structuredView(row, rows, render) {
  const fail = message => { throw new Error(`${message}; source preserved. Inspect the Studio record before retrying`); };
  const obj = x => x && typeof x === 'object' && !Array.isArray(x);
  const escape = text => text.replace(/[\r\n\t]+/g, ' ').replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, '\\$&');
  const ident = x => typeof x === 'string' && x.length > 0;
  const header = `---\nbyok-id: ${JSON.stringify(String(row.id))}\nbyok-type: ${row.kind === 'manuscript' ? 'manuscript' : 'outline'}\n---\n\n`;
  const issues = [];
  if (row.kind === 'file') {
    if (!Array.isArray(row.data.content)) fail('Outline content is not an array');
    const ids = new Set(), lines = [];
    function visit(nodes, depth) {
      if (depth > 100) fail('Outline nesting exceeds the supported limit');
      for (const node of nodes) {
        if (!obj(node) || !ident(node.id) || typeof node.text !== 'string' || !['I', 'II'].includes(node.type) || !Array.isArray(node.children) || typeof node.isCollapsed !== 'boolean') fail('Malformed or unrecognized outline node');
        if (Object.keys(node).some(k => !['id', 'text', 'type', 'children', 'isCollapsed'].includes(k))) fail('Unrecognized outline node fields');
        if (ids.has(node.id)) fail(`Repeated outline node ID ${node.id}`);
        ids.add(node.id);
        if (/[\r\n\t]/.test(node.text)) issues.push('Outline text contains line breaks or tabs flattened in the readable view; original text is retained in metadata');
        lines.push(`${'  '.repeat(depth)}- ${escape(node.text)} <!-- byok-outline-id: ${Buffer.from(node.id).toString('hex')}; byok-outline-fields: ${Buffer.from(JSON.stringify([node.type, node.isCollapsed, node.text])).toString('hex')} -->`);
        visit(node.children, depth + 1);
      }
    }
    visit(row.data.content, 0);
    return { content: header + (lines.length ? lines.join('\n') + '\n' : ''), issues };
  }
  if (!Array.isArray(row.data.manuscripts)) fail('Manuscript entries are not an array');
  const ids = new Set(), references = new Set(), lines = [];
  for (const [index, entry] of row.data.manuscripts.entries()) {
    if (!obj(entry) || !ident(entry.id) || !Number.isInteger(entry.position) || entry.position !== index || !obj(entry.file) || !ident(entry.file.id)) fail(`Malformed or unrecognized manuscript entry at ${index + 1}`);
    if (Object.keys(entry).some(k => !['id', 'position', 'color', 'outline_item_id', 'outlineItemId', 'file'].includes(k))) fail(`Unrecognized manuscript entry fields at ${index + 1}`);
    if (typeof entry.color !== 'string') fail(`Malformed manuscript color at ${index + 1}`);
    if (!Object.hasOwn(entry, 'outline_item_id') || !Object.hasOwn(entry, 'outlineItemId') || entry.outline_item_id !== null || entry.outlineItemId !== null) fail(`Unrecognized manuscript outline association at ${index + 1}`);
    if (ids.has(entry.id)) fail(`Repeated manuscript entry ID ${entry.id}`);
    ids.add(entry.id);
    if (references.has(entry.file.id)) issues.push(`Repeated file reference ${entry.file.id} retained`);
    references.add(entry.file.id);
    const matches = rows.filter(r => r.kind === 'file' && String(r.id) === entry.file.id);
    const file = matches[0];
    if (matches.length !== 1 || !file.data || file.is_trashed || file.type !== 'text' || typeof file.data.name !== 'string' || typeof file.data.content !== 'string' || String(file.project_id) !== String(row.project_id)) fail(`Manuscript entry ${entry.id} references missing, unavailable, or unsupported file ${entry.file.id}`);
    const result = render(file.data.content);
    issues.push(...result.issues);
    lines.push(`## ${escape(file.data.name)}\n\n<!-- byok-entry-id: ${Buffer.from(entry.id).toString('hex')}; byok-file-id: ${Buffer.from(entry.file.id).toString('hex')}; byok-color: ${Buffer.from(entry.color).toString('hex')} -->\n\n${result.body}`);
  }
  return { content: header + lines.join('\n'), issues: [...new Set(issues)] };
}
module.exports = { structuredView };
