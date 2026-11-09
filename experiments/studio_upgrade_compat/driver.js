// Drives a real Studio inside the network-less jail over the DevTools protocol.
// Run by Electron-as-Node: `studio driver.js <phase>`. Only /work is writable.
// Nothing here calls Studio's sync, account or update code.
const { spawn } = require('child_process');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROJECT = 'Synthetic Upgrade Project';
const BRIDGE_PROJECT = 'Synthetic Bridge Project';
const BRIDGE_PROJECT_ID = 'upgrade-bridge-project';
const BRIDGE_FOLDER = 'Synthetic Folder';
const FIRST = 'First synthetic paragraph typed in the older Studio build.';
const SECOND = ' Second synthetic sentence typed in the older Studio build.';
const AFTER_UPGRADE = 'Edit typed in Studio 1.1.3 after the upgrade.';

async function launch() {
  const xvfb = spawn('/opt/xvfb/Xvfb',
    [':99', '-screen', '0', '1400x1000x24', '-nolisten', 'tcp', '-extension', 'GLX'], { stdio: 'ignore' });
  await sleep(1500);
  const env = { ...process.env, DISPLAY: ':99' };
  delete env.ELECTRON_RUN_AS_NODE;
  const studio = spawn('/opt/studio/electron/studio',
    ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=9222'], { stdio: 'ignore', env });
  let exited = null;
  studio.on('exit', (code, signal) => { exited = { code, signal }; });
  const pages = async () => {
    try { return (await (await fetch('http://127.0.0.1:9222/json')).json()).filter((t) => t.type === 'page'); }
    catch { return []; }
  };
  for (let i = 0; i < 80 && !(await pages()).length; i++) await sleep(500);
  await sleep(5000);
  const [page] = await pages();
  if (!page) throw new Error('Studio exposed no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const call = (expr) => ev(`(async () => JSON.stringify(await ${expr}))()`).then((s) => (s === undefined ? undefined : JSON.parse(s)));
  const clickText = async (text, selector = 'button,a,[role=button],li,div,span') => {
    const box = await ev(`(() => {
      const hits = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((e) => e.offsetParent !== null && e.innerText && e.innerText.trim() === ${JSON.stringify(text)})
        .filter((e) => {
          const b = e.getBoundingClientRect();
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return top && (top === e || e.contains(top) || top.contains(e));
        });
      const el = hits[hits.length - 1];
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    if (!box) return false;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
    await sleep(100);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
    return true;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result) fs.writeFileSync(`/work/${name}`, Buffer.from(s.result.data, 'base64'));
  };
  const quit = async () => {
    await Promise.race([send('Browser.close'), sleep(3000)]);
    for (let i = 0; i < 40 && !exited; i++) await sleep(250);
    const clean = exited;
    if (!exited) studio.kill('SIGTERM');
    await sleep(500);
    xvfb.kill();
    return clean;
  };
  return { ev, call, send, clickText, shot, quit };
}

const editorHtml = (s) => s.ev(`document.querySelector('.ProseMirror')?.innerHTML ?? null`);
const netInterfaces = () => fs.readFileSync('/proc/net/dev', 'utf8')
  .split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
function appVersion() {
  try { return require('/opt/studio/electron/resources/app.asar/package.json').version; } catch { return null; }
}

const flatten = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === 'object') {
    if (node.type === 'text' && node.id) out.push(node);
    Object.values(node).forEach((v) => flatten(v, out));
  }
  return out;
};
const visibleButtons = (s) => s.ev(`[...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null).map((e) => e.innerText.trim() || e.getAttribute('aria-label') || '?')`);
const typeIntoEditor = async (s, text) => {
  await s.ev(`document.querySelector('.ProseMirror').focus()`);
  await s.send('Input.insertText', { text });
  await sleep(6000);
};

// Records beyond the UI-created one are written through the older build's own
// mirror bridge, so their stored JSON is shaped by that build. That path queues
// no outbox work, and these calls never touch `sync` or `ops`.
// BRIDGE_PROJECT omits the `user` key; a project made in Studio's UI stores
// `"user": null`, which is what the control record below exercises.
function bridgeRecords(ui, html) {
  const base = { ...ui, project: BRIDGE_PROJECT_ID };
  for (const k of ['versions', 'comments']) delete base[k];
  return [
    { ...base, id: 'upgrade-plain', name: 'Synthetic Plain Record', content: '<p>Plain synthetic paragraph from the older build.</p>' },
    { ...base, id: 'upgrade-studio-html', name: 'Synthetic Studio HTML Record', content: html },
    { ...base, id: 'upgrade-folder-file', name: 'Synthetic Folder Record', folder: 'upgrade-folder', content: '<p>Synthetic paragraph inside a folder.</p>' },
    { ...base, id: 'upgrade-rich', name: 'Synthetic Rich Record', content: '<h2>Synthetic heading</h2><p><strong>Bold</strong> synthetic body.</p>' },
    { ...base, id: 'upgrade-extra-keys', name: 'Synthetic Extra Keys Record', content: '<p>Synthetic record with extra JSON keys.</p>', legacyKeepMe: { nested: [1, 'two', null] }, wordGoal: 500 },
    { ...base, id: 'upgrade-nontext', type: 'grid', name: 'Synthetic Non-text Record', content: '{"rows":[]}' },
    { ...base, project: ui.project, id: 'upgrade-in-ui-project', name: 'Synthetic Record In UI Project', content: '<p>Outbox-free record inside a UI-created project.</p>' },
  ];
}

async function seed(s, out) {
  await s.clickText('OK', 'button');
  await sleep(800);
  await s.clickText('Start a new project');
  await sleep(1500);
  await s.ev(`document.querySelector('input[placeholder="Enter project name"]').focus()`);
  await s.send('Input.insertText', { text: PROJECT });
  await sleep(400);
  await s.clickText('Create', 'button');
  await sleep(5000);
  // 0.5.2 returns to the project list after creating a project.
  if (await s.ev('location.pathname.endsWith("/projects")')) {
    if (!(await s.clickText(PROJECT))) throw new Error('new project tile not found');
    await sleep(4000);
  }
  out.buttons_in_project = await visibleButtons(s);
  if (!(await s.clickText('Text', 'button'))) throw new Error(`no Text button: ${out.buttons_in_project}`);
  await sleep(2500);
  out.buttons_in_dialog = await visibleButtons(s);
  if (!(await s.clickText('Create', 'button'))) throw new Error(`no Create button: ${out.buttons_in_dialog}`);
  await sleep(5000);
  await typeIntoEditor(s, FIRST);
  const projectId = (await s.ev('location.href')).split('/').pop();
  const [file] = flatten(await s.call(`window.desktop.mirror.getProjectTree(${JSON.stringify(projectId)})`));
  if (!file) throw new Error('Studio did not persist the typed file');
  out.project_id = projectId;
  out.ui_file_id = file.id;
  out.studio_snapshot = await s.call(`window.desktop.versions.snapshot(${JSON.stringify(file.id)}, 'manual')`);
  await typeIntoEditor(s, SECOND);
  const ui = await s.call(`window.desktop.mirror.getFile(${JSON.stringify(file.id)})`);
  out.ui_file = ui;
  const project = { id: BRIDGE_PROJECT_ID, name: BRIDGE_PROJECT, type: 'book', createdAt: ui.createdAt, updatedAt: ui.updatedAt };
  out.put_project = await s.call(`window.desktop.mirror.putProject(${JSON.stringify(project)})`);
  const folder = { id: 'upgrade-folder', name: BRIDGE_FOLDER, project: BRIDGE_PROJECT_ID, createdAt: ui.createdAt, updatedAt: ui.updatedAt };
  out.put_folder = await s.call(`window.desktop.mirror.putFolder(${JSON.stringify(folder)})`);
  const records = bridgeRecords(ui, ui.content);
  out.put_files = [];
  for (const r of records) out.put_files.push(await s.call(`window.desktop.mirror.putFile(${JSON.stringify(r)})`));
  out.bridge_ids = records.map((r) => r.id);
  await sleep(1500);
}

async function read(s, out, target) {
  const ids = [target.ui_file_id, ...target.bridge_ids];
  out.files = {};
  out.versions = {};
  for (const id of ids) {
    out.files[id] = await s.call(`window.desktop.mirror.getFile(${JSON.stringify(id)})`);
    out.versions[id] = await s.call(`window.desktop.versions.list(${JSON.stringify(id)})`);
  }
  out.tree = await s.call(`window.desktop.mirror.getProjectTree(${JSON.stringify(target.project_id)})`);
  out.folder = await s.call(`window.desktop.mirror.getFolder('upgrade-folder')`);
  out.projects = await s.call('window.desktop.mirror.listProjects()');
  out.stats = await s.call('window.desktop.mirror.stats()');
  out.app_version = await s.ev('window.desktop.version');
}

async function openRecord(s, path) {
  await s.clickText('OK', 'button');
  await sleep(800);
  if (!(await s.clickText(BRIDGE_PROJECT))) throw new Error('project tile not found');
  await sleep(4000);
  for (const name of path.slice(0, -1)) {
    if (!(await s.clickText(name))) throw new Error(`folder entry not found: ${name}`);
    await sleep(1500);
  }
  const name = path[path.length - 1];
  if (!(await s.clickText(name))) throw new Error(`record entry not found: ${name}`);
  await sleep(4000);
  if (!(await editorHtml(s))) throw new Error('editor did not open');
}

async function uiEdit(s, out, target) {
  const id = JSON.stringify(target.edit_id);
  out.before_edit = await s.call(`window.desktop.mirror.getFile(${id})`);
  await openRecord(s, target.edit_path);
  out.editor_html = await editorHtml(s);
  await s.shot('reopened.png');
  await typeIntoEditor(s, AFTER_UPGRADE);
  out.after_edit = await s.call(`window.desktop.mirror.getFile(${id})`);
  out.versions = await s.call(`window.desktop.versions.list(${id})`);
}

const PHASES = { seed, read, 'ui-edit': uiEdit };
(async () => {
  const phase = process.argv[2];
  const target = fs.existsSync('/work/target.json') ? JSON.parse(fs.readFileSync('/work/target.json', 'utf8')) : {};
  const out = { phase, jail_network_interfaces: netInterfaces(), electron: process.versions.electron, studio_app_version: appVersion() };
  if (out.jail_network_interfaces.join() !== 'lo') { console.error('jail has a network interface'); process.exit(3); }
  const s = await launch();
  try {
    out.desktop_mode = await s.ev('window.desktop && window.desktop.mode');
    if (!PHASES[phase]) throw new Error(`unknown phase ${phase}`);
    await PHASES[phase](s, out, target);
  } catch (err) {
    out.error = String((err && err.stack) || err);
    await s.shot(`failure-${phase}.png`);
  }
  out.studio_exit = await s.quit();
  fs.writeFileSync(`/work/${phase}.json`, JSON.stringify(out, null, 1));
  process.exit(out.error ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
