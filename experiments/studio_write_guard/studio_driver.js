// Runs inside the network-less jail, as Electron-as-Node, and controls a real
// Studio for lab_studio.py. Commands arrive on stdin as JSON lines and one JSON
// result line is written per command. Everything Studio stores goes to /work,
// which is a disposable synthetic directory.
const { spawn } = require('child_process');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROJECT = 'Synthetic Guard Project';
const FILE = 'Untitled Text';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let xvfb;
let launches = 0;
let studio = null;
let exited = null;
let ws = null;
let seq = 0;
const pending = new Map();

function startStudio(extraPort) {
  launches += 1;
  const env = { ...process.env, DISPLAY: ':99' };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(`/work/studio-${launches}.log`, 'w');
  return spawn('/opt/studio/electron/studio',
    ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${extraPort}`],
    { stdio: ['ignore', log, log], env });
}

const pages = async () => {
  try { return (await (await fetch('http://127.0.0.1:9222/json')).json()).filter((t) => t.type === 'page'); }
  catch { return []; }
};

const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params }));
});

async function attach(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !exited && !(await pages()).length) await sleep(250);
  if (exited) return { page: false, exited, ms: Date.now() - started };
  const list = await pages();
  if (!list.length) return { page: false, alive: true, ms: Date.now() - started };
  await sleep(4000);
  const [page] = await pages();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  await send('Page.enable');
  return { page: true, ms: Date.now() - started };
}

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

const typeIntoEditor = async (text) => {
  await ev(`document.querySelector('.ProseMirror').focus()`);
  await send('Input.insertText', { text });
  await sleep(6000);
};
const flatten = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === 'object') {
    if (node.type === 'text' && node.id) out.push(node);
    Object.values(node).forEach((v) => flatten(v, out));
  }
  return out;
};

const commands = {
  async launch_nowait() {
    exited = null; ws = null;
    studio = startStudio(9222);
    studio.on('exit', (code, signal) => { exited = { code, signal }; });
    return { pid: studio.pid };
  },
  async attach(a) { return attach(a.timeout_ms || 40000); },
  async launch(a) {
    const r = await commands.launch_nowait();
    return { ...r, ...(await attach(a.timeout_ms || 40000)) };
  },
  async status() { return { alive: !exited, exited, pages: (await pages()).length }; },
  async seed() {
    await clickText('OK', 'button');
    await sleep(800);
    await clickText('Start a new project');
    await sleep(1500);
    await ev(`document.querySelector('input[placeholder="Enter project name"]').focus()`);
    await send('Input.insertText', { text: PROJECT });
    await sleep(400);
    await clickText('Create', 'button');
    await sleep(5000);
    await clickText('Text', 'button');
    await sleep(2500);
    await clickText('Create', 'button');
    await sleep(5000);
    await typeIntoEditor('Original synthetic body typed through the Studio UI.');
    const projectId = (await ev('location.href')).split('/').pop();
    const [file] = flatten(await call(`window.desktop.mirror.getProjectTree(${JSON.stringify(projectId)})`));
    if (!file) throw new Error('Studio did not persist the typed file');
    return { project_id: projectId, file_id: file.id, mode: await ev('window.desktop.mode') };
  },
  async open_and_edit() {
    await clickText('OK', 'button');
    await sleep(800);
    if (!(await clickText(PROJECT))) throw new Error('project tile not found');
    await sleep(4000);
    if (!(await ev(`document.querySelector('.ProseMirror')?.innerHTML ?? null`))) {
      if (!(await clickText(FILE))) throw new Error('file entry not found');
      await sleep(4000);
    }
    await typeIntoEditor(' Edit typed in Studio while the guard was probing.');
    return {};
  },
  async get_file(a) { return { file: await call(`window.desktop.mirror.getFile(${JSON.stringify(a.id)})`) }; },
  async second_instance() {
    const started = Date.now();
    const second = startStudio(9333);
    const result = await Promise.race([
      new Promise((r) => second.on('exit', (code, signal) => r({ exited: true, code, signal }))),
      sleep(20000).then(() => ({ exited: false })),
    ]);
    if (!result.exited) second.kill('SIGKILL');
    return { ...result, ms: Date.now() - started, log: `studio-${launches}.log` };
  },
  async kill9() {
    studio.kill('SIGKILL');
    for (let i = 0; i < 40 && !exited; i++) await sleep(100);
    await sleep(1500); // let helper processes exit
    return { exited };
  },
  async quit() {
    if (ws) await Promise.race([send('Browser.close'), sleep(3000)]);
    for (let i = 0; i < 40 && !exited; i++) await sleep(250);
    const clean = exited;
    if (!exited) { studio.kill('SIGTERM'); await sleep(1000); }
    return { clean_exit: clean, exited };
  },
  async end() {
    if (studio && !exited) studio.kill('SIGKILL');
    if (xvfb) xvfb.kill();
    await sleep(300);
    say({ ok: true });
    process.exit(0);
  },
};

async function main() {
  xvfb = spawn('/opt/xvfb/Xvfb', [':99', '-screen', '0', '1400x1000x24', '-nolisten', 'tcp', '-extension', 'GLX'], { stdio: 'ignore' });
  await sleep(1500);
  const interfaces = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
  say({ ok: true, ready: true, interfaces, electron: process.versions.electron, pid_inside_jail: process.pid });
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      chain = chain.then(async () => {
        try { say({ ok: true, ...(await commands[request.cmd](request)) }); }
        catch (e) { say({ ok: false, error: String(e && e.stack || e) }); }
      });
    }
  });
}
main();
