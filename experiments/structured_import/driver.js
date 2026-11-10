// Drives a real Studio inside the network-less jail over the DevTools protocol.
// Run by Electron-as-Node: `studio driver.js <seed|verify|edit-restore>`.
// Everything it writes goes to /work, which is disposable.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROJECT = 'Synthetic Write-back Project';
const FILE = 'Untitled Text';
const V1 = 'Original synthetic body typed through the Studio UI.';
const V2 = ' Second synthetic sentence typed through the Studio UI.';
const AFTER_WRITEBACK = ' Edit typed in Studio after the write-back.';

async function launch() {
  const xvfb = spawn('/opt/xvfb/Xvfb',
    [':99', '-screen', '0', '1400x1000x24', '-nolisten', 'tcp', '-extension', 'GLX'],
    { stdio: 'ignore' });
  await sleep(1500);
  const env = { ...process.env, DISPLAY: ':99' };
  delete env.ELECTRON_RUN_AS_NODE;
  const studio = spawn('/opt/studio/electron/studio',
    ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=9222'],
    { stdio: 'ignore', env });
  let exited = null;
  studio.on('exit', (code, signal) => { exited = { code, signal }; });

  const pages = async () => {
    try { return (await (await fetch('http://127.0.0.1:9222/json')).json()).filter((t) => t.type === 'page'); }
    catch { return []; }
  };
  for (let i = 0; i < 80 && !(await pages()).length; i++) await sleep(500);
  await sleep(4000);
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
          // Skip copies that exist but are covered or off-screen, such as the collapsed drawer.
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
const flatten = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === 'object') {
    if (node.type === 'text' && node.id) out.push(node);
    Object.values(node).forEach((v) => flatten(v, out));
  }
  return out;
};
const typeIntoEditor = async (s, text) => {
  await s.ev(`document.querySelector('.ProseMirror').focus()`);
  await s.send('Input.insertText', { text });
  await sleep(6000);
};
const openLibraryFile = async (s) => {
  await s.clickText('OK', 'button');
  await sleep(800);
  if (!(await s.clickText(PROJECT))) throw new Error('project tile not found after reopen');
  await sleep(4000);
  if (!(await editorHtml(s))) {
    if (!(await s.clickText(FILE))) throw new Error('file entry not found after reopen');
    await sleep(4000);
  }
  if (!(await editorHtml(s))) throw new Error('editor did not open after reopen');
};
const netInterfaces = () => fs.readFileSync('/proc/net/dev', 'utf8')
  .split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);

function appVersion() {
  try { return require('/opt/studio/electron/resources/app.asar/package.json').version; }
  catch { return null; }
}

async function seed(s, out) {
  const click = async (text, selector = 'button') => {
    if (!await s.clickText(text, selector)) throw new Error(`missing UI control: ${text}`);
    await sleep(1000);
  };
  await s.clickText('OK', 'button'); await sleep(800);
  await click('Start a new project', 'button,a,[role=button],li,div,span');
  await s.ev(`document.querySelector('input[placeholder="Enter project name"]').focus()`);
  await s.send('Input.insertText', { text: PROJECT }); await click('Create'); await sleep(4000);
  const projectId = (await s.ev('location.href')).split('/').pop();
  await click('Outline'); await click('Create'); await sleep(3000);
  const disk = () => { const py = `import sqlite3,json\nc=sqlite3.connect('file:/work/config/studio-desktop/byokwa/db.sqlite?mode=ro',uri=True)\nprint(json.dumps({t:[json.loads(r[0]) for r in c.execute('select data from '+t)] for t in ['files','manuscript_files']}))`; const p=spawnSync('/usr/bin/python3',['-c',py],{encoding:'utf8'}); if(p.status !== 0) throw new Error(p.stderr); return JSON.parse(p.stdout); };
  const waitDisk = async (predicate) => { for (let i=0;i<60;i++) { const d=disk(); if(predicate(d)) return d; await sleep(500); } throw new Error('persisted save timeout'); };
  const tree = () => s.call(`window.desktop.mirror.getProjectTree(${JSON.stringify(projectId)})`);
  // The UI-generated textarea carries the ID; query the file via the tree if needed.
  out.tree_initial = await tree();
  await click('Add your first header');
  await s.send('Input.insertText', {text:'Synthetic header A'}); await sleep(1000);
  await click('Add subheader');
  await s.send('Input.insertText', {text:'Synthetic child A'});
  await s.ev('document.activeElement.blur()');
  const waitFor = async (marker) => { for (let i=0; i<40; i++) { const v=await tree(); if (JSON.stringify(v).includes(marker)) return v; await sleep(500); } throw new Error(`save timeout: ${marker}`); };
  out.tree_outline_before = await waitFor('Synthetic child A');
  out.disk_outline_before = await waitDisk(d=>JSON.stringify(d).includes('Synthetic child A'));
  await s.ev(`document.querySelector('textarea[aria-label="Header text"]').focus()`);
  await s.send('Input.insertText', {text:' edited'}); await s.ev('document.activeElement.blur()');
  out.tree_outline_after = await waitFor(' edited');
  out.disk_outline_after = await waitDisk(d=>JSON.stringify(d).includes(' edited'));
  await s.ev(`document.querySelector('button[aria-label="Close document"]').click()`); await sleep(3000);
  await click('Manuscript'); await click('Create'); await sleep(3000);
  out.tree_manuscript_empty = await tree();
  out.disk_manuscript_empty = await waitDisk(d=>d.manuscript_files.length === 1);
  await click('Create New File'); await click('Continue'); await click('Create'); await sleep(5000);
  await s.ev(`document.querySelector('.manuscript-page-content').focus()`);
  await s.send('Input.insertText', {text:'Synthetic manuscript body.'}); await sleep(10000);
  out.tree_manuscript_after = await tree();
  out.disk_manuscript_after = await waitDisk(d=>JSON.stringify(d.files).includes('Synthetic manuscript body.'));
  out.ui = await s.ev('document.body.innerText');
  await s.ev(`document.querySelector('button[title="Add files to manuscript"]').click()`); await sleep(1000);
  await click('Create New File'); await click('Continue'); await click('Create'); await sleep(5000);
  out.disk_two = await waitDisk(d=>d.manuscript_files[0]?.manuscripts.length === 2);
  out.tree_two = await tree();
  out.controls_two = await s.ev(`Array.from(document.querySelectorAll('button[title="Move up"]')).map(e=>e.outerHTML)`);
  await s.ev(`Array.from(document.querySelectorAll('button[title="Move up"]')).at(-1).click()`); await sleep(4000);
  out.disk_reordered = await waitDisk(d=>d.manuscript_files[0]?.manuscripts[0]?.id === out.disk_two.manuscript_files[0].manuscripts[1].id);
  out.tree_reordered = await tree();

}

async function verify(s, out, target) {
  const id = JSON.stringify(target.file_id);
  const readAll = async () => ({
    file: await s.call(`window.desktop.mirror.getFile(${id})`),
    tree: await s.call(`window.desktop.mirror.getProjectTree(${JSON.stringify(target.project_id)})`),
    activity: await s.call('window.desktop.mirror.getProjectActivity()'),
    projects: await s.call('window.desktop.mirror.listProjects()'),
    versions: await s.call(`window.desktop.versions.list(${id})`),
    stats: await s.call('window.desktop.mirror.stats()'),
  });
  out.at_boot = await readAll();
  out.pre_image = target.pre_image_version_id
    ? await s.call(`window.desktop.versions.get(${id}, ${JSON.stringify(target.pre_image_version_id)})`)
    : null;
  out.cache = await s.call(`(async () => {
    const local = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));
    const dump = JSON.stringify(local);
    return {
      local_storage_keys: Object.keys(local),
      local_storage_mentions_pre_writeback_text: dump.includes(${JSON.stringify(V2.trim())}),
      indexed_db: (await indexedDB.databases()).map((d) => d.name),
    };
  })()`);
  await openLibraryFile(s);
  out.editor_html = await editorHtml(s);
  await s.shot('reopened.png');
  await sleep(10000);
  out.editor_html_after_idle = await editorHtml(s);
  out.after_idle = await readAll();
}

async function editRestore(s, out, target) {
  const id = JSON.stringify(target.file_id);
  await openLibraryFile(s);
  await typeIntoEditor(s, AFTER_WRITEBACK);
  out.file_after_ui_edit = await s.call(`window.desktop.mirror.getFile(${id})`);
  out.restore_result = await s.call(`window.desktop.versions.restore(${id}, ${JSON.stringify(target.pre_image_version_id)})`);
  await sleep(1500);
  out.file_after_restore = await s.call(`window.desktop.mirror.getFile(${id})`);
  out.versions_after_restore = await s.call(`window.desktop.versions.list(${id})`);
}

(async () => {
  const phase = process.argv[2];
  const target = fs.existsSync('/work/target.json') ? JSON.parse(fs.readFileSync('/work/target.json', 'utf8')) : {};
  const out = {
    phase,
    jail_network_interfaces: netInterfaces(),
    electron: process.versions.electron,
    studio_app_version: appVersion(),
  };
  const s = await launch();
  try {
    out.desktop_mode = await s.ev('window.desktop.mode');
    if (phase === 'seed') await seed(s, out);
    else if (phase === 'verify') await verify(s, out, target);
    else if (phase === 'edit-restore') await editRestore(s, out, target);
    else throw new Error(`unknown phase ${phase}`);
  } catch (err) {
    out.error = String(err && err.stack || err);
    await s.shot(`failure-${phase}.png`);
  }
  out.studio_exit = await s.quit();
  fs.writeFileSync(`/work/${phase}.json`, JSON.stringify(out, null, 1));
  process.exit(out.error ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
