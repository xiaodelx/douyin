/**
 * Tool-level smoke test: registers the plugin against a fake Cordis context and
 * exercises the read-only half of the desktop agent for real.
 *
 * It never clicks, types into another app, or opens Douyin — destructive input
 * belongs to a real session where the user is watching.
 *
 *   node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { apply, Config } from '../lib/index.js';

const tools = new Map();
const disposers = [];
const ctx = {
  tools: {
    register(tool) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
  },
  get(service) {
    if (service !== 'logger') return undefined;
    return {
      info: (message) => console.log(`[info] ${message}`),
      warn: (message) => console.warn(`[warn] ${message}`),
    };
  },
  effect(callback) {
    const dispose = callback();
    disposers.push(dispose);
    return dispose;
  },
};

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function run(toolName, args, signal) {
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`tool ${toolName} is not registered`);
  const value = await tool.execute(args, { signal, callId: 'test', name: toolName });
  const content = tool.output.render(args, value);
  return { value, text: content.map((block) => block.text).join('\n') };
}

const controller = new AbortController();
const signal = controller.signal;

try {
  apply(ctx, Config({}));
  check('registers both tools', tools.has('computer') && tools.has('douyin'), [...tools.keys()].join(', '));

  const info = await run('computer', { action: 'screen_info' }, signal);
  check('screen_info reports a real display', info.value.data.width > 0 && info.value.data.height > 0, `${info.value.data.width}x${info.value.data.height} dpiAware=${info.value.data.dpiAware}`);
  check('screen_info renders text', info.text.length > 0);

  const shot = await run('computer', { action: 'screenshot', mode: 'screen', max_width: 640 }, signal);
  const bytes = readFileSync(shot.value.shot.path);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  check('screenshot writes a PNG', isPng && bytes.length > 1000, `${shot.value.shot.path} ${bytes.length}B`);
  check('screenshot respects max_width', shot.value.shot.width <= 640, `${shot.value.shot.width}px`);

  const cursor = await run('computer', { action: 'cursor' }, signal);
  check('cursor returns a position', Number.isFinite(cursor.value.data.x) && Number.isFinite(cursor.value.data.y), `${cursor.value.data.x},${cursor.value.data.y}`);

  const moved = await run('computer', { action: 'move', x: cursor.value.data.x, y: cursor.value.data.y, duration_ms: 60 }, signal);
  check('move settles on the same point', moved.value.data.x === cursor.value.data.x && moved.value.data.y === cursor.value.data.y);

  const windows = await run('computer', { action: 'windows' }, signal);
  check('windows lists visible windows', windows.value.data.windows.length > 0, `${windows.value.data.windows.length} windows`);

  const marker = `大肥鱼 desktop test 🐟 ${Date.now()}`;
  const set = await run('computer', { action: 'clipboard_set', text: marker }, signal);
  const got = await run('computer', { action: 'clipboard_get' }, signal);
  check('clipboard round-trips unicode', got.value.data.text === marker, `${set.value.data.length} chars`);
  check('clipboard_get renders the content', got.text.includes('大肥鱼'));

  const waited = await run('computer', { action: 'wait', ms: 120 }, signal);
  check('wait returns ok', waited.value.ok === true);

  const status = await run('douyin', { action: 'status' }, signal);
  check('douyin status is answerable', typeof status.value.data.running === 'boolean', status.value.text);
  if (status.value.data.running) {
    const calib = await run('douyin', { action: 'calibrate' }, signal);
    check('douyin calibrate captures the window', calib.value.data.shot.width > 0, `${calib.value.data.shot.path}`);
  }

  const resume = await run('computer', { action: 'resume' }, signal);
  check('resume clears the kill switch', resume.value.data.stopped === false);

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('\nSMOKE TEST CRASHED');
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      console.warn(`dispose failed: ${String(error)}`);
    }
  }
}
