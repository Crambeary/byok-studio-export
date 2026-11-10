// Drives a real Studio inside the network-less jail over the DevTools protocol.
// Run by Electron-as-Node: `studio driver.js <seed|verify|edit-restore>`.
// Everything it writes goes to /work, which is disposable.
const { spawn } = require('child_process');
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
  await s.clickText('OK', 'button');
  await sleep(800);
  await s.clickText('Start a new project');
  await sleep(1500);
  await s.ev(`document.querySelector('input[placeholder="Enter project name"]').focus()`);
  await s.send('Input.insertText', { text: PROJECT });
  await sleep(400);
  await s.clickText('Create', 'button');
  await sleep(5000);
  await s.clickText('Text', 'button');
  await sleep(2500);
  await s.clickText('Create', 'button');
  await sleep(5000);
  await typeIntoEditor(s, V1);

  const projectId = (await s.ev('location.href')).split('/').pop();
  const [file] = flatten(await s.call(`window.desktop.mirror.getProjectTree(${JSON.stringify(projectId)})`));
  if (!file) throw new Error('Studio did not persist the typed file');
  out.project_id = projectId;
  out.file_id = file.id;
  out.studio_snapshot = await s.call(`window.desktop.versions.snapshot(${JSON.stringify(file.id)}, 'manual')`);
  await typeIntoEditor(s, V2);
  out.file_after_typing = await s.call(`window.desktop.mirror.getFile(${JSON.stringify(file.id)})`);
  out.editor_html = await editorHtml(s);
  const duplicate = { ...out.file_after_typing, id: 'synthetic-duplicate', content: '<p>duplicate untouched sentinel</p>', position: 1 };
  const unrelated = { ...out.file_after_typing, id: 'synthetic-unrelated', name: 'Unrelated', content: '<p>unrelated untouched sentinel</p>', position: 2 };
  out.seed_bridge_results = [];
  for (const item of [duplicate, unrelated]) out.seed_bridge_results.push(await s.call(`window.desktop.mirror.putFile(${JSON.stringify(item)})`));
  out.seed_tree = await s.call(`window.desktop.mirror.getProjectTree(${JSON.stringify(projectId)})`);
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

async function card(s, out, target) {
  await sleep(15000);
  out.connected = await s.call('window.desktop.device.get()');
  out.plan = await s.call("window.desktop.device.plan({linebreakMode:'paragraph'})");
  out.body = await s.ev('document.body.innerText');
  out.buttons = await s.ev("[...document.querySelectorAll('button')].map(e=>e.innerText.trim()).filter(Boolean)");
  if (process.argv[2] === 'card') {
    if (!await s.clickText('Bring in changes (1)', 'button')) throw new Error('Import button unavailable');
    await sleep(7000);
    out.after_body = await s.ev('document.body.innerText');
    out.after_file = await s.call(`window.desktop.mirror.getFile(${JSON.stringify(target.file_id)})`);
    out.after_versions = await s.call(`window.desktop.versions.list(${JSON.stringify(target.file_id)})`);
    out.after_plan = await s.call("window.desktop.device.plan({linebreakMode:'paragraph'})");
  }
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
    else if (phase === 'card' || phase === 'replan') await card(s, out, target);
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
