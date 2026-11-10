const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { realpath } = require("node:fs/promises");
const { parseDocument } = require("htmlparser2");
const { structuredView } = require("./structured");
const exec = promisify(execFile);

// A single SELECT holds one SQLite read snapshot across all tables, including WAL.
async function readLibrary(path) {
  const sql = `SELECT 'project' AS kind, id, NULL AS project_id, NULL AS folder_id, NULL AS type, 0 AS is_trashed, data FROM projects
    UNION ALL SELECT 'folder', id, NULL, parent_folder_id, NULL, 0, data FROM folders
    UNION ALL SELECT 'file', id, project_id, folder_id, type, is_trashed, data FROM files
    UNION ALL SELECT 'manuscript', id, project_id, folder_id, 'manuscript', is_trashed, data FROM manuscript_files;`;
  const { stdout } = await exec("sqlite3", ["-readonly", "-json", path, sql], { maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(stdout || "[]").map(row => {
    try { const data = JSON.parse(row.data); if (!data || typeof data !== "object" || Array.isArray(data)) throw Error(); return { ...row, rawData: row.data, data }; }
    catch { return { ...row, rawData: row.data, data: null }; }
  });
}
async function readRecord(path, row) {
  const table = row.kind === "file" ? "files" : "manuscript_files";
  const id = Buffer.from(String(row.id)).toString("hex");
  const columns = row.kind === "file" ? "type" : "'manuscript' AS type";
  const sql = `SELECT '${row.kind}' AS kind, id, project_id, folder_id, ${columns}, is_trashed, data FROM ${table} WHERE id=CAST(X'${id}' AS TEXT);`;
  const { stdout } = await exec("sqlite3", ["-readonly", "-json", path, sql], { maxBuffer: 128 * 1024 * 1024 });
  const found = JSON.parse(stdout || "[]")[0];
  return found && { ...found, rawData: found.data, data: JSON.parse(found.data) };
}
function limit(value, bytes = 180) {
  let result = "";
  for (const ch of value) { if (Buffer.byteLength(result + ch) > bytes) break; result += ch; }
  return result.replace(/[.\s]+$/u, "");
}
function safe(value) {
  let name = String(value || "Untitled").normalize("NFC").replace(/[\\/:*?"<>|#^\[\]\x00-\x1f]/g, "-").trim().replace(/[.\s]+$/u, "");
  if (name.startsWith(".")) name = "_" + name;
  name = limit(name);
  return (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) ? "Untitled" : name;
}
function collisionKey(path, normalize = value => value.replace(/\u00a0/g, " ")) { return normalize(path).normalize("NFC").toLowerCase(); }
function withSuffix(name, suffix, extension = "") { return limit(name, 180 - Buffer.byteLength(suffix + extension)) + suffix + extension; }

function render(html, literalSafe = false) {
  const issues = new Set();
  function visit(node) {
    if (node.type === "text") return literalSafe ? node.data.replace(/[\r\n\t]+/g, " ").replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, "\\$&") : node.data;
    if (node.type !== "tag") { issues.add("non-text HTML"); return ""; }
    const children = (node.children || []).map(visit).join("");
    if (Object.keys(node.attribs || {}).length) issues.add("HTML attributes");
    switch (node.name) {
      case "p": case "div": return children + "\n\n";
      case "br": return "\n";
      case "strong": case "b": return `**${children}**`;
      case "em": case "i": return `*${children}*`;
      case "h1": case "h2": case "h3": return `${"#".repeat(Number(node.name[1]))} ${children}\n\n`;
      default: issues.add(`<${node.name}>`); return children;
    }
  }
  const body = parseDocument(html).children.map(visit).join("").trim() + "\n";
  // Markdown syntax and even supported HTML cannot yet be proven round-trip safe.
  issues.add("HTML-to-Markdown conversion is not verified lossless");
  return { body, issues: [...issues] };
}
function metadata(id, updated) {
  return `---\nbyok-id: ${JSON.stringify(String(id))}\nbyok-type: text\nbyok-updated: ${JSON.stringify(String(updated || ""))}\n---\n\n`;
}
function destination(value) {
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some(p => p === "." || p === ".." || safe(p) !== p)) throw new Error("Invalid destination folder");
  return parts.join("/");
}
async function sync({ database, folder, vault, vaultId, state, save, normalizePath }) {
  const keyForPath = path => collisionKey(path, normalizePath);
  const root = destination(folder);
  const library = await realpath(database);
  const rows = await readLibrary(library); // no vault mutations until the source has been read
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(state) || state.version !== 1 || !object(state.scopes)) throw new Error("Invalid import state");
  if (typeof vaultId !== "string" || !vaultId) throw new Error("Vault identity required");
  const key = JSON.stringify([library, vaultId, root]);
  const marker = [root, `.byok-sync-${createHash("sha256").update(key).digest("hex")}.json`].filter(Boolean).join("/");
  const hasScope = Object.hasOwn(state.scopes, key);
  if (!hasScope && await vault.exists(marker)) throw new Error("Import state missing for this scope; restore plugin data from backup before retrying");
  const entries = hasScope ? state.scopes[key] : {};
  if (!object(entries)) throw new Error("Invalid import scope");
  const reservedPaths = new Set();
  for (const entry of Object.values(entries)) {
    if (!object(entry) || typeof entry.path !== "string" || !entry.path || typeof entry.baseline !== "string" || (Object.hasOwn(entry, "studioContent") && typeof entry.studioContent !== "string") || (Object.hasOwn(entry, "pending") && entry.pending !== true)) throw new Error("Invalid record baseline");
    const parts = entry.path.split("/");
    if (entry.path.includes("\\") || parts.some(p => !p || p === "." || p === ".." || safe(p) !== p) || (root && !entry.path.startsWith(root + "/")) || reservedPaths.has(keyForPath(entry.path))) throw new Error("Invalid or duplicate record path");
    reservedPaths.add(keyForPath(entry.path));
    if (Object.hasOwn(entry, "ancestors") && (!Array.isArray(entry.ancestors) || entry.ancestors.length !== entry.path.split("/").length - (root ? root.split("/").length : 0) - 1 || entry.ancestors.some((id, i) => typeof id !== "string" || !id.startsWith(i === 0 ? "project:" : "folder:")))) throw new Error("Invalid ancestor state");
    if (Object.hasOwn(entry, "textRefresh") && (!object(entry.textRefresh) || typeof entry.textRefresh.from !== "string" || typeof entry.textRefresh.to !== "string" || typeof entry.textRefresh.studio !== "string" || entry.textRefresh.from !== entry.baseline)) throw new Error("Invalid text refresh state");
    if (Object.hasOwn(entry, "structuredRefresh") && (!object(entry.structuredRefresh) || typeof entry.structuredRefresh.from !== "string" || typeof entry.structuredRefresh.to !== "string" || entry.structuredRefresh.from !== entry.baseline)) throw new Error("Invalid structured refresh state");
    if (Object.hasOwn(entry, "recovery")) {
      const r = entry.recovery;
      if (!object(r) || typeof r.vault !== "string" || typeof r.studio !== "string" || typeof r.intended !== "string") throw new Error("Invalid write recovery state");
    }
    if (Object.hasOwn(entry, "conflict")) {
      const c = entry.conflict;
      if (!object(c) || typeof c.path !== "string" || !c.path || typeof c.note !== "string" || typeof c.snapshot !== "string" || typeof c.vaultOriginal !== "string" || c.path.includes("\\") || c.path.split("/").some(p => !p || p === "." || p === ".." || safe(p) !== p) || (root && !c.path.startsWith(root + "/")) || reservedPaths.has(keyForPath(c.path))) throw new Error("Invalid conflict state");
      reservedPaths.add(keyForPath(c.path));
    }
  }
  if (!hasScope) {
    state.scopes[key] = entries;
    try { await save(state); } catch (error) { delete state.scopes[key]; throw error; }
  }
  let markerText, savedMarker;
  if (!await vault.exists(marker)) {
    if (hasScope && Object.keys(entries).length) throw new Error("Import marker missing; restore it from backup");
    savedMarker = { version: 1, scope: key, ids: [] };
    markerText = JSON.stringify(savedMarker);
    await vault.create(marker, markerText);
  } else {
    try { markerText = await vault.read(marker); savedMarker = JSON.parse(markerText); } catch { throw new Error("Invalid import marker; restore it from backup"); }
    if (!savedMarker || savedMarker.version !== 1 || savedMarker.scope !== key || (savedMarker.ids !== undefined && (!Array.isArray(savedMarker.ids) || savedMarker.ids.some(id => typeof id !== "string") || new Set(savedMarker.ids).size !== savedMarker.ids.length))) throw new Error("Invalid import marker; restore it from backup");
  }
  if (savedMarker.ids && savedMarker.ids.some(id => !Object.hasOwn(entries, id))) throw new Error("Import state missing records; restore plugin data from backup");
  const legacyMarker = !savedMarker.ids;
  async function reserveMarker(id) {
    if (legacyMarker) throw new Error("Legacy import marker cannot prove record identity; manual recovery required");
    if (savedMarker.ids.includes(id)) return;
    const next = { ...savedMarker, ids: [...savedMarker.ids, id] };
    const nextText = JSON.stringify(next);
    if (typeof vault.compareAndWrite !== "function" || !await vault.compareAndWrite(marker, markerText, nextText)) throw new Error("Import marker changed or cannot be safely updated");
    savedMarker = next; markerText = nextText;
  }
  const safeToMutate = async path => typeof vault.safeToMutate === "function" && await vault.safeToMutate(path);

  const reports = [];
  const projects = new Map(rows.filter(r => r.kind === "project").map(r => [String(r.id), r]));
  const folders = new Map(rows.filter(r => r.kind === "folder").map(r => [String(r.id), r]));
  function folderParts(id) {
    const seen = new Set(), result = [];
    while (id != null && id !== "") {
      id = String(id);
      if (seen.has(id) || !folders.has(id)) throw new Error(`Invalid folder hierarchy: ${id}`);
      seen.add(id); const f = folders.get(id); if (!f.data) throw new Error(`Malformed folder ${id}`); result.unshift(safe(f.data.name)); id = f.folder_id;
    }
    return result;
  }
  const records = rows.filter(r => r.kind === "file" || r.kind === "manuscript");
  // Only persisted ancestor identities can associate old paths with source nodes.
  // Legacy directories are reserved by path, without guessing their owners.
  const names = new Map(), owners = new Map(), ambiguous = new Set(), occupied = new Set();
  function chainFor(row) {
    const project = projects.get(String(row.project_id));
    if (!project || !project.data) throw new Error(`Missing or malformed project ${row.project_id}`);
    folderParts(row.folder_id); let id = row.folder_id; const chain = [];
    while (id != null && id !== "") { const f = folders.get(String(id)); chain.unshift(f); id = f.folder_id; }
    return [project, ...chain];
  }
  function identity(row, index) { return `${index === 0 ? "project" : "folder"}:${row.id}`; }
  function remember(parent, id, name) {
    const ownerKey = JSON.stringify([parent, keyForPath(name)]), nameKey = JSON.stringify([parent, id]);
    if ((names.has(nameKey) && names.get(nameKey) !== name) || (owners.has(ownerKey) && owners.get(ownerKey) !== id)) ambiguous.add(parent);
    else { names.set(nameKey, name); owners.set(ownerKey, id); }
  }
  for (const entry of Object.values(entries)) {
    const parts = entry.path.split('/').slice(root ? root.split('/').length : 0, -1);
    let parent = '', physical = '';
    parts.forEach((name, i) => {
      physical = [physical, name].filter(Boolean).join('/'); occupied.add(keyForPath(physical));
      if (entry.ancestors) { const id = entry.ancestors[i]; remember(parent, id, name); parent = JSON.stringify([parent, id]); }
    });
  }
  if (Object.values(entries).some(entry => !entry.ancestors)) {
    reports.push({ status: 'legacy-hierarchy', detail: 'Older imports lack folder identities. New notes may use separate suffixed folders; existing notes are preserved.' });
  }
  function hierarchy(row) {
    let parent = '', physical = '';
    return chainFor(row).map((item, i) => {
      if (ambiguous.has(parent)) throw new Error('Ambiguous existing hierarchy mapping; manual reconciliation required');
      const id = identity(item, i), nameKey = JSON.stringify([parent, id]);
      let name = names.get(nameKey);
      if (!name) {
        const base = safe(item.data?.name); name = base;
        const taken = candidate => owners.has(JSON.stringify([parent, keyForPath(candidate)])) || occupied.has(keyForPath([physical, candidate].filter(Boolean).join("/")));
        if (taken(name)) { const suffix = createHash('sha256').update(id).digest('hex'); let n = 16; do { name = withSuffix(base, ` (${suffix.slice(0, n)})`); n += 4; } while (taken(name) && n <= 68); if (taken(name)) throw new Error('Hierarchy name collision'); }
        remember(parent, id, name);
      }
      physical = [physical, name].filter(Boolean).join("/"); occupied.add(keyForPath(physical));
      parent = JSON.stringify([parent, id]); return name;
    });
  }
  const seen = new Set();
  const reportRecovery = id => reports.push({ id, status: "recovery-required", path: entries[id].path, detail: "A Studio write may have been interrupted. Preserve both notes and the saved recovery snapshots; reconcile manually before clearing recovery state." });
  for (const row of records) {
    const id = `${row.kind}:${row.id}`; seen.add(id);
    if (entries[id]?.recovery) reportRecovery(id);
    if (row.is_trashed) { reports.push({ id, status: "trashed" }); continue; }
    if (!row.data) { reports.push({ id, status: "failed", detail: "Malformed record JSON; source preserved" }); continue; }
    if ((row.kind === "file" && ["outline", "cardstack", "grid"].includes(row.type)) || row.kind === "manuscript") {
      if (entries[id]?.recovery) {
        if (row.kind === 'file' && ['cardstack', 'grid'].includes(row.type)) reports.push({ id, status: 'unsupported', detail: 'Structured record requires recovery before projection' });
        continue;
      }
      try {
        const { content, issues } = structuredView(row, rows, html => render(html, true));
        if (issues.length) reports.push({ id, status: "lossy", detail: issues.join(", ") });
        // Recheck the entire snapshot: manuscript projections depend on other rows.
        const sourceUnchanged = async () => JSON.stringify(await readLibrary(library)) === JSON.stringify(rows);
        const prior = entries[id];
        if (prior) {
          if (prior.conflict) { reports.push({ id, status: "changed", path: prior.path, detail: "Existing conflict requires manual recovery" }); continue; }
          if (prior.pending === true) {
            await reserveMarker(id);
            if (!await safeToMutate(prior.path)) { reports.push({ id, status: "changed", path: prior.path, detail: "Close editors before retrying" }); continue; }
            if (await vault.read(prior.path) !== null || await vault.exists(prior.path)) { reports.push({ id, status: "changed", path: prior.path, detail: "Reserved path occupied; preserve and move the note before retrying" }); continue; }
            if (!await sourceUnchanged()) { reports.push({ id, status: "changed-during-sync", path: prior.path }); continue; }
            const previousBaseline = prior.baseline;
            prior.baseline = content;
            try { await save(state); } catch (error) { prior.baseline = previousBaseline; throw error; }
            if (!await sourceUnchanged() || !await safeToMutate(prior.path)) { reports.push({ id, status: "changed-during-sync", path: prior.path }); continue; }
            await vault.create(prior.path, content);
            delete prior.pending;
            try { await save(state); } catch (error) { prior.pending = true; throw error; }
            reports.push({ id, status: "recovered", path: prior.path }); continue;
          }
          const current = await vault.read(prior.path);
          if (current === null) { reports.push({ id, status: "missing", path: prior.path }); continue; }
          if (prior.structuredRefresh) {
            const intent = prior.structuredRefresh;
            if (current === intent.to) {
              prior.baseline = intent.to; delete prior.structuredRefresh;
              try { await save(state); } catch (error) { prior.baseline = intent.from; prior.structuredRefresh = intent; throw error; }
              if (current === content) {
                reports.push({ id, status: await sourceUnchanged() ? "recovered" : "changed-during-sync", path: prior.path }); continue;
              }
            } else {
              if (current !== intent.from) { reports.push({ id, status: "changed", path: prior.path, detail: "Interrupted structured refresh requires manual reconciliation" }); continue; }
              delete prior.structuredRefresh;
              try { await save(state); } catch (error) { prior.structuredRefresh = intent; throw error; }
            }
          }
          if (current !== prior.baseline) { reports.push({ id, status: "changed", path: prior.path, detail: "Structured view edited; preserved. Reconcile manually before refreshing" }); continue; }
          if (current === content) { reports.push({ id, status: "unchanged", path: prior.path }); continue; }
          if (!await sourceUnchanged() || !await safeToMutate(prior.path) || typeof vault.compareAndWrite !== "function") { reports.push({ id, status: "changed-during-sync", path: prior.path }); continue; }
          const intent = { from: current, to: content }; prior.structuredRefresh = intent;
          try { await save(state); } catch (error) { delete prior.structuredRefresh; throw error; }
          if (!await sourceUnchanged() || !await safeToMutate(prior.path) || !await vault.compareAndWrite(prior.path, current, content)) { reports.push({ id, status: "changed-during-sync", path: prior.path }); continue; }
          prior.baseline = content; delete prior.structuredRefresh;
          try { await save(state); } catch (error) { prior.baseline = current; prior.structuredRefresh = intent; throw error; }
          reports.push({ id, status: "updated", path: prior.path }); continue;
        }
        const directory = [root, ...hierarchy(row)].filter(Boolean).join("/");
        const name = safe(row.data.name);
        const makePath = suffix => [directory, withSuffix(name, suffix, ".md")].filter(Boolean).join("/");
        let path = makePath(""), n = 1;
        while (reservedPaths.has(keyForPath(path)) || await vault.exists(path)) { if (n === 1) reports.push({ id, status: "collision", path }); if (++n > 10000) throw Error("Too many path collisions"); path = makePath(` (${n})`); }
        if (!await sourceUnchanged()) { reports.push({ id, status: "changed-during-sync", path }); continue; }
        if (!await safeToMutate(path)) { reports.push({ id, status: "changed", path, detail: "Close editors before retrying" }); continue; }
        if (legacyMarker) throw new Error("Legacy import marker cannot prove record identity; manual recovery required");
        entries[id] = { path, baseline: content, ancestors: chainFor(row).map(identity), pending: true };
        try { await save(state); } catch (error) { delete entries[id]; throw error; }
        reservedPaths.add(keyForPath(path)); await reserveMarker(id); await vault.create(path, content);
        delete entries[id].pending;
        try { await save(state); } catch (error) { entries[id].pending = true; throw error; }
        reports.push({ id, status: "imported", path });
      } catch (e) { reports.push({ id, status: row.kind === 'file' && ['cardstack', 'grid'].includes(row.type) && /source preserved/.test(String(e.message)) ? 'unsupported' : 'failed', detail: String(e.message || e) }); }
      continue;
    }
    if (row.kind !== "file" || row.type !== "text" || typeof row.data.content !== "string") {
      reports.push({ id, status: "unsupported", detail: String(row.type || "unknown") }); continue;
    }
    if (entries[id]?.recovery) continue;
    try {
      const { body, issues } = render(row.data.content);
      reports.push({ id, status: "lossy", detail: issues.join(", ") });
      const content = metadata(row.id, row.data.updatedAt) + body;
      const prior = entries[id];
      if (Object.hasOwn(entries, id)) {
        if (!object(prior) || typeof prior.path !== "string" || !prior.path || typeof prior.baseline !== "string" || (Object.hasOwn(prior, "studioContent") && typeof prior.studioContent !== "string")) throw new Error("Invalid record baseline");
        if (prior.pending === true) {
          await reserveMarker(id);
          if (!await safeToMutate(prior.path)) { reports.push({ id, status: "changed", path: prior.path, detail: "Editor state unavailable or note open; close editors before retrying" }); continue; }
          const existing = await vault.read(prior.path);
          if (existing === null) {
            if (await vault.exists(prior.path)) { reports.push({ id, status: "changed", path: prior.path }); continue; }
            const fresh = await readRecord(library, row);
            if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row)) { reports.push({ id, status: "changed-during-sync", path: prior.path }); continue; }
            const oldBaseline = prior.baseline, oldStudio = prior.studioContent;
            prior.baseline = content; prior.studioContent = row.data.content;
            try { await save(state); } catch (error) { prior.baseline = oldBaseline; prior.studioContent = oldStudio; throw error; }
            const rechecked = await readRecord(library, row);
            if (!rechecked || JSON.stringify(rechecked) !== JSON.stringify(row) || !await safeToMutate(prior.path)) { reports.push({ id, status: "changed-during-sync", path: prior.path }); continue; }
            await vault.create(prior.path, content);
          } else { reports.push({ id, status: "changed", path: prior.path, detail: "Reserved path is occupied; ownership cannot be proven. Close editors, move the note to another path, then retry and reconcile the preserved note" }); continue; }
          delete prior.pending;
          try { await save(state); } catch (error) { prior.pending = true; throw error; }
          reports.push({ id, status: "recovered", path: prior.path }); continue;
        }
        const current = await vault.read(prior.path);
        if (current === null) { reports.push({ id, status: "missing", path: prior.path }); continue; }
        if (prior.conflict) {
          reports.push({ id, status: "conflict", path: prior.path, detail: `Previous conflict requires manual recovery; preserve the Studio snapshot at ${prior.conflict.path}` }); continue;
        }
        if (typeof prior.studioContent !== "string") {
          reports.push({ id, status: "changed", path: prior.path, detail: "Studio baseline missing; manual recovery required" }); continue;
        }
        if (prior.textRefresh) {
          const intent = prior.textRefresh;
          if (current === intent.to) {
            const oldStudioContent = prior.studioContent;
            prior.baseline = intent.to; prior.studioContent = intent.studio; delete prior.textRefresh;
            try { await save(state); } catch (error) { prior.baseline = intent.from; prior.studioContent = oldStudioContent; prior.textRefresh = intent; throw error; }
            if (current === content) {
              const fresh = await readRecord(library, row);
              reports.push({ id, status: fresh && JSON.stringify(fresh) === JSON.stringify(row) ? "recovered" : "changed-during-sync", path: prior.path }); continue;
            }
          } else if (current === intent.from) {
            delete prior.textRefresh;
            try { await save(state); } catch (error) { prior.textRefresh = intent; throw error; }
          } else { reports.push({ id, status: "changed", path: prior.path, detail: "Interrupted refresh requires manual reconciliation" }); continue; }
        }
        if (current === prior.baseline && current === content) {
          reports.push({ id, status: "unchanged", path: prior.path }); continue;
        }
        if (current !== prior.baseline) {
          reports.push({ id, status: "changed", path: prior.path, detail: "Vault edit preserved; reconcile manually before refreshing" }); continue;
        }
        // Verify the source snapshot again, then compare and replace the note atomically.
        const fresh = await readRecord(library, row);
        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row)) {
          reports.push({ id, status: "changed-during-sync", path: prior.path }); continue;
        }
        if (!await safeToMutate(prior.path) || typeof vault.compareAndWrite !== "function") { reports.push({ id, status: "changed-during-sync", path: prior.path }); continue; }
        const intent = { from: current, to: content, studio: row.data.content }; prior.textRefresh = intent;
        try { await save(state); } catch (error) { delete prior.textRefresh; throw error; }
        const rechecked = await readRecord(library, row);
        if (!rechecked || JSON.stringify(rechecked) !== JSON.stringify(row) || !await safeToMutate(prior.path) || !await vault.compareAndWrite(prior.path, current, content)) {
          reports.push({ id, status: "changed-during-sync", path: prior.path }); continue;
        }
        const oldBaseline = prior.baseline, oldStudioContent = prior.studioContent;
        prior.baseline = content; prior.studioContent = row.data.content; delete prior.textRefresh;
        try { await save(state); } catch (error) { prior.baseline = oldBaseline; prior.studioContent = oldStudioContent; prior.textRefresh = intent; throw error; }
        reports.push({ id, status: "updated", path: prior.path }); continue;
      }
      const directory = [root, ...hierarchy(row)].filter(Boolean).join("/");
      const name = safe(row.data.name);
      const makePath = suffix => [directory, withSuffix(name, suffix, ".md")].filter(Boolean).join("/");
      let path = makePath(""), n = 1;
      while (reservedPaths.has(keyForPath(path)) || await vault.exists(path)) { if (n === 1) reports.push({ id, status: "collision", path }); if (++n > 10000) throw Error("Too many path collisions"); path = makePath(` (${n})`); }
      const fresh = await readRecord(library, row);
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row)) { reports.push({ id, status: "changed-during-sync", path }); continue; }
      if (!await safeToMutate(path)) { reports.push({ id, status: "changed", path, detail: "Editor state unavailable; close editors before retrying" }); continue; }
      if (legacyMarker) throw new Error("Legacy import marker cannot prove record identity; manual recovery required");
      entries[id] = { path, baseline: content, studioContent: row.data.content, ancestors: chainFor(row).map(identity), pending: true };
      try { await save(state); } catch (error) { delete entries[id]; throw error; }
      reservedPaths.add(keyForPath(path));
      await reserveMarker(id);
      await vault.create(path, content);
      delete entries[id].pending;
      try { await save(state); } catch (error) { entries[id].pending = true; throw error; }
      reports.push({ id, status: "imported", path });
    } catch (e) { reports.push({ id, status: "failed", detail: String(e.message || e) }); }
  }
  for (const id of Object.keys(entries)) if (!seen.has(id)) {
    if (entries[id].recovery) reportRecovery(id);
    reports.push({ id, status: "deleted", path: entries[id].path });
  }
  return reports;
}
module.exports = { sync, readLibrary, destination };
