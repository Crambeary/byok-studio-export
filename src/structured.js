// Read-only projection of the shapes captured in experiments/structured_import.
function structuredView(row, rows, render) {
  const fail = message => { throw new Error(`${message}; source preserved. Inspect the Studio record before retrying`); };
  const obj = x => x && typeof x === 'object' && !Array.isArray(x);
  const escape = text => text.replace(/[\r\n\t]+/g, ' ').replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, '\\$&');
  const ident = x => typeof x === 'string' && x.length > 0;
  const header = `---\nbyok-id: ${JSON.stringify(String(row.id))}\nbyok-type: ${row.kind === 'manuscript' ? 'manuscript' : row.type || 'outline'}\n---\n\n`;
  if (row.kind === 'file' && ['cardstack', 'grid'].includes(row.type)) {
    const keys = (value, expected) => obj(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
    const plain = value => typeof value === 'string' && !/<\/?[a-zA-Z][^>]*>/.test(value);
    const empty = value => Array.isArray(value) && value.length === 0;
    const ids = new Set();
    const unique = id => { const key = JSON.stringify(id); if (ids.has(key)) fail('Repeated structured ID'); ids.add(key); };
    const content = row.data.content;
    if (row.type === 'cardstack') {
      if (!Array.isArray(content)) fail('Malformed cardstack');
      for (const section of content) {
        if (!keys(section, ['title', 'cardSize', 'cards']) || !plain(section.title) || section.cardSize !== 'medium' || !Array.isArray(section.cards)) fail('Unrecognized cardstack section');
        for (const card of section.cards) {
          if (!keys(card, ['id', 'title', 'content', 'color']) || !(ident(card.id) || (Number.isSafeInteger(card.id) && card.id >= 0)) || !plain(card.title) || !plain(card.content) || card.color !== null) fail('Unrecognized card');
          unique(card.id);
        }
      }
    } else {
      if (!keys(content, ['tiles', 'connections', 'groups', 'labels', 'v2']) || !['tiles', 'connections', 'groups', 'labels'].every(k => empty(content[k]))) fail('Unrecognized grid structure');
      const v = content.v2;
      if (!keys(v, ['version', 'unit', 'tiles', 'connections', 'groups', 'labels']) || v.version !== 2 || v.unit !== 25 || !Array.isArray(v.tiles) || !['connections', 'groups', 'labels'].every(k => empty(v[k]))) fail('Unrecognized grid version or structure');
      for (const tile of v.tiles) {
        if (!keys(tile, ['id', 'x', 'y', 'w', 'h', 'content', 'color', 'isHeader']) || !ident(tile.id) || !['x', 'y', 'w', 'h'].every(k => Number.isSafeInteger(tile[k])) || tile.w <= 0 || tile.h <= 0 || !plain(tile.content) || tile.color !== null || tile.isHeader !== false) fail('Unrecognized grid tile');
        unique(tile.id);
      }
    }
    const json = JSON.stringify(content, null, 2);
    const longest = Math.max(2, ...Array.from(json.matchAll(/`+/g), match => match[0].length));
    const fence = '`'.repeat(longest + 1);
    return { content: header + fence + 'json\n' + json + '\n' + fence + '\n', issues: [] };
  }
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
