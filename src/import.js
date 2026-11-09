const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { realpath } = require("node:fs/promises");
const { parseDocument } = require("htmlparser2");
const { guardedWrite } = require("./writeback");
const { htmlToMarkdown, markdownToHtml } = require("./text-codec");
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
  return (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) ? "Untitled" : name;
}
function collisionKey(path) { return path.normalize("NFC").toLowerCase(); }
function withSuffix(name, suffix, extension = "") { return limit(name, 180 - Buffer.byteLength(suffix + extension)) + suffix + extension; }

function render(html) {
  const issues = new Set();
  function visit(node) {
    if (node.type === "text") return node.data;
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
function createSync(write = guardedWrite) {
return async function sync({ database, folder, vault, vaultId, state, save, studioAsar }) {
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
    if (entry.path.includes("\\") || parts.some(p => !p || p === "." || p === ".." || safe(p) !== p) || (root && !entry.path.startsWith(root + "/")) || reservedPaths.has(collisionKey(entry.path))) throw new Error("Invalid or duplicate record path");
    reservedPaths.add(collisionKey(entry.path));
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
  // Disambiguate same-named projects and sibling folders deterministically.
  function component(row, peers) {
    const name = safe(row.data?.name);
    return peers.filter(p => collisionKey(safe(p.data?.name)) === collisionKey(name)).length > 1
      ? withSuffix(name, ` (${createHash("sha256").update(String(row.id)).digest("hex").slice(0, 16)})`) : name;
  }
  function hierarchy(row) {
    const project = projects.get(String(row.project_id));
    if (!project || !project.data) throw new Error(`Missing or malformed project ${row.project_id}`);
    const projectName = component(project, [...projects.values()]);
    folderParts(row.folder_id); let id = row.folder_id; const chain = [];
    while (id != null && id !== "") { const f = folders.get(String(id)); chain.unshift(f); id = f.folder_id; }
    return [projectName, ...chain.map(f => component(f, [...folders.values()].filter(p => String(p.folder_id || "") === String(f.folder_id || ""))))];
  }
  const records = rows.filter(r => r.kind === "file" || r.kind === "manuscript");
  const seen = new Set();
  for (const row of records) {
    const id = `${row.kind}:${row.id}`; seen.add(id);
    if (row.is_trashed) { reports.push({ id, status: "trashed" }); continue; }
    if (!row.data) { reports.push({ id, status: "failed", detail: "Malformed record JSON; source preserved" }); continue; }
    if (row.kind !== "file" || row.type !== "text" || typeof row.data.content !== "string") {
      reports.push({ id, status: "unsupported", detail: String(row.type || "unknown") }); continue;
    }
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
            await vault.create(prior.path, prior.baseline);
          } else { reports.push({ id, status: "changed", path: prior.path, detail: "Reserved path is occupied; ownership cannot be proven, manual recovery required" }); continue; }
          delete prior.pending;
          try { await save(state); } catch (error) { prior.pending = true; throw error; }
          reports.push({ id, status: "recovered", path: prior.path }); continue;
        }
        const current = await vault.read(prior.path);
        if (current === null) { reports.push({ id, status: "missing", path: prior.path }); continue; }
        const hasStudioBaseline = typeof prior.studioContent === "string";
        if (current === content && current === prior.baseline) {
          reports.push({ id, status: hasStudioBaseline ? "unchanged" : "changed", path: prior.path, ...(!hasStudioBaseline ? { detail: "Studio baseline missing; manual recovery required" } : {}) }); continue;
        }
        // Recovery only advances an existing, complete baseline when both current sides
        // prove equivalence. Recheck both snapshots before changing anything.
        const oldMarkdown = hasStudioBaseline ? htmlToMarkdown(prior.studioContent) : null;
        const newMarkdown = htmlToMarkdown(row.data.content);
        let oldPrefix = oldMarkdown && prior.baseline.endsWith(oldMarkdown) ? prior.baseline.slice(0, -oldMarkdown.length) : null;
        if (oldPrefix !== null) {
          try {
            const updated = oldPrefix.match(/\nbyok-updated: (.*)\n---\n\n$/);
            if (!updated || oldPrefix !== metadata(row.id, JSON.parse(updated[1]))) oldPrefix = null;
          } catch { oldPrefix = null; }
        }
        const equivalentEdit = oldPrefix !== null && newMarkdown !== null && current === oldPrefix + newMarkdown && current !== prior.baseline;
        if (hasStudioBaseline && (current === content || equivalentEdit)) {
          const fresh = await readRecord(library, row);
          if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row) || !await safeToMutate(prior.path) || typeof vault.compareAndWrite !== "function" || !await vault.compareAndWrite(prior.path, current, content)) {
            reports.push({ id, status: "changed-during-sync", path: prior.path }); continue;
          }
          const oldBaseline = prior.baseline, oldStudioContent = prior.studioContent;
          prior.baseline = content; prior.studioContent = row.data.content;
          try { await save(state); } catch (error) { prior.baseline = oldBaseline; prior.studioContent = oldStudioContent; throw error; }
          reports.push({ id, status: "recovered", path: prior.path }); continue;
        }
        if (!hasStudioBaseline) { reports.push({ id, status: "changed", path: prior.path, detail: "Studio baseline missing; manual recovery required" }); continue; }
        if (current !== prior.baseline) {
          // Classify a narrow reversible subset without enabling database writes.
          const prefix = metadata(row.id, row.data.updatedAt);
          const original = htmlToMarkdown(row.data.content);
          const edited = current.startsWith(prefix) ? markdownToHtml(current.slice(prefix.length)) : null;
          const reversible = row.data.content === prior.studioContent && original !== null && prefix + original === prior.baseline && edited !== null;
          if (!reversible || !studioAsar) {
            reports.push({ id, status: "changed", path: prior.path, detail: reversible
              ? "Vault edit preserved; reversible text, but closed-Studio write guard is unavailable"
              : "Vault edit preserved; conversion is unsupported or lossy and Studio write-back is unavailable" }); continue;
          }
          if (!await safeToMutate(prior.path) || typeof vault.compareAndWrite !== "function" || await vault.read(prior.path) !== current) {
            reports.push({ id, status: "changed-during-sync", path: prior.path }); continue;
          }
          const normalized = markdownToHtml(current.slice(prefix.length), row.data.content);
          if (normalized === null) throw new Error("Unsupported paragraph form; manual recovery required");
          const stamp = await write(library, row, normalized, studioAsar);
          const applied = metadata(row.id, stamp) + current.slice(prefix.length);
          if (!await safeToMutate(prior.path) || !await vault.compareAndWrite(prior.path, current, applied)) {
            reports.push({ id, status: "failed", path: prior.path, detail: "Studio updated, but vault changed; manual recovery required" }); continue;
          }
          const oldBaseline = prior.baseline, oldStudioContent = prior.studioContent;
          prior.baseline = applied; prior.studioContent = normalized;
          try { await save(state); } catch (error) { prior.baseline = oldBaseline; prior.studioContent = oldStudioContent; throw error; }
          reports.push({ id, status: "written-back", path: prior.path }); continue;
        }
        // Verify the source snapshot again, then compare and replace the note atomically.
        const fresh = await readRecord(library, row);
        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row)) {
          reports.push({ id, status: "changed-during-sync", path: prior.path }); continue;
        }
        if (!await safeToMutate(prior.path) || typeof vault.compareAndWrite !== "function" || !await vault.compareAndWrite(prior.path, current, content)) {
          reports.push({ id, status: "changed-during-sync", path: prior.path }); continue;
        }
        const oldBaseline = prior.baseline, oldStudioContent = prior.studioContent;
        prior.baseline = content; prior.studioContent = row.data.content;
        try { await save(state); } catch (error) { prior.baseline = oldBaseline; prior.studioContent = oldStudioContent; throw error; }
        reports.push({ id, status: "updated", path: prior.path }); continue;
      }
      const directory = [root, ...hierarchy(row)].filter(Boolean).join("/");
      const name = safe(row.data.name);
      const makePath = suffix => [directory, withSuffix(name, suffix, ".md")].filter(Boolean).join("/");
      let path = makePath(""), n = 1;
      while (reservedPaths.has(collisionKey(path)) || await vault.exists(path)) { if (n === 1) reports.push({ id, status: "collision", path }); if (++n > 10000) throw Error("Too many path collisions"); path = makePath(` (${n})`); }
      const fresh = await readRecord(library, row);
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row)) { reports.push({ id, status: "changed-during-sync", path }); continue; }
      if (!await safeToMutate(path)) { reports.push({ id, status: "changed", path, detail: "Editor state unavailable; close editors before retrying" }); continue; }
      entries[id] = { path, baseline: content, studioContent: row.data.content, pending: true };
      try { await save(state); } catch (error) { delete entries[id]; throw error; }
      reservedPaths.add(collisionKey(path));
      await reserveMarker(id);
      await vault.create(path, content);
      delete entries[id].pending;
      try { await save(state); } catch (error) { entries[id].pending = true; throw error; }
      reports.push({ id, status: "imported", path });
    } catch (e) { reports.push({ id, status: "failed", detail: String(e.message || e) }); }
  }
  for (const id of Object.keys(entries)) if (!seen.has(id)) reports.push({ id, status: "deleted", path: entries[id].path });
  return reports;
}
}
const sync = createSync();
module.exports = { sync, createSync, readLibrary, destination };
