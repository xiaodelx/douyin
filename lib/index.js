/**
 * dsh-plugin-computer-use — let the agent drive the Windows desktop and watch
 * Douyin.
 *
 * Two tools are registered:
 *   - `computer`: raw desktop control (screen, pointer, keyboard, windows,
 *     clipboard, launching programs).
 *   - `douyin`: a feed driver that only synthesizes ordinary human input on
 *     the visible Douyin window.
 *
 * All Win32 work happens in a persistent PowerShell child process
 * (`lib/agent.ps1`); this module owns the tool contracts, the configuration,
 * and the safety rails. Every input action can be stopped by the user with
 * Ctrl+Alt+Shift+Q, which sets the agent's panic flag.
 *
 * @module dsh-plugin-computer-use
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { PcAgent, PcAgentError } from './agent-client.js';
import { createDouyin, DouyinError } from './douyin.js';

export const name = 'computer-use';

export const inject = ['tools'];

/** Plugin configuration; every deployment-tunable value lives here. */
export const Config = Schema.object({
  screenshotMaxWidth: Schema.number().default(1280)
    .description('Longest edge of a returned screenshot, in pixels. Smaller images cost fewer tokens; larger ones show more detail.'),
  agentTimeoutMs: Schema.number().default(20000)
    .description('Per-request timeout for the desktop agent.'),
  outputDir: Schema.string().default('')
    .description('Directory for screenshots and agent state. Empty uses the OS temp directory.'),
  douyinUrl: Schema.string().default('https://www.douyin.com/')
    .description('Page opened by the douyin tool\'s "open" action.'),
  douyinWindowTitle: Schema.string().default('抖音')
    .description('Window-title substring that identifies the Douyin window.'),
  maxWatchCount: Schema.number().default(20)
    .description('Upper bound for one "watch" batch when the call does not set count.'),
  minDwellMs: Schema.number().default(3000)
    .description('Shortest time spent on one video before swiping.'),
  maxDwellMs: Schema.number().default(12000)
    .description('Longest time spent on one video before swiping.'),
  likeChance: Schema.number().default(0.2)
    .description('Probability of liking a video during a watch batch (0 disables likes).'),
  maxLikesPerRun: Schema.number().default(5)
    .description('Hard cap on likes inside one watch batch.'),
  openTimeoutMs: Schema.number().default(25000)
    .description('How long "open" waits for the Douyin window to appear.'),
});

const COMPUTER_ACTIONS = [
  'screen_info',
  'screenshot',
  'cursor',
  'move',
  'click',
  'drag',
  'scroll',
  'type',
  'key',
  'hotkey',
  'windows',
  'focus',
  'launch',
  'clipboard_get',
  'clipboard_set',
  'wait',
  'panic',
  'resume',
];

const DOUYIN_ACTIONS = ['status', 'open', 'enter', 'next', 'prev', 'like', 'pause', 'play', 'comment', 'watch', 'calibrate', 'stop'];

const COMPUTER_DESCRIPTION = [
  'Control the Windows desktop with real input: read the screen, move/click the pointer, type text, press keys, list and focus windows, use the clipboard, and launch programs.',
  'Coordinates are physical screen pixels (origin: top-left of the primary monitor, which may be smaller than your first screenshot suggests on scaled displays). Call action "screen_info" once, then action "screenshot" before clicking anything so the coordinates come from what is actually on screen.',
  'Every call is irreversible live input on the user\'s desktop: nothing is simulated or sandboxed. Prefer the smallest action (one click, a short wait), re-screenshot after the UI changes, and never click through destructive dialogs (delete, format, payment, "uninstall") on your own.',
  'Never type passwords, API keys, or personal data unless the user explicitly supplied that exact text for this step, and never paste from the clipboard without knowing what it holds.',
  'Kill switch: the user can hold Ctrl+Alt+Shift+Q at any moment. Every further input then fails with code KILL_SWITCH until action "resume" is called; action "panic" raises the same flag and "resume" clears it.',
].join(' ');

const DOUYIN_DESCRIPTION = [
  'Drive the Douyin (抖音) feed in the visible Douyin window: open it, open a video, swipe to the next/previous one, like, pause/play, and watch a batch of videos with human-like dwell times.',
  'Two surfaces are handled automatically: the PC client (window title "抖音", home page is a grid, player opens by clicking a card and advances with ArrowDown/ArrowUp) and the web player in a browser (advances with the mouse wheel). It only synthesizes the mouse clicks, wheel, and keys a person would use; it has no API access, no cookies, and no account credentials.',
  'Typical sequence: action "status" with screenshot: true → on the PC client, action "enter" to open the first video → action "watch" with count and dwell range. "watch" returns the number of videos, the likes it gave, screenshot paths, and stops early on the kill switch; always look at the last screenshot to confirm the feed really advanced.',
  'Use action "watch" for a batch: it dwells a random time per video, swipes on, optionally likes with a small probability, and returns what it did. Counts and dwell ranges are capped by the plugin configuration.',
  'Likes and comments are visible to real people: keep them rare, and only comment with action "comment" after the user approved the exact text and you pass confirm: true — never comment, follow, or message on your own initiative. Stop if a login wall, captcha, or verification prompt appears instead of trying to get around it.',
  'Coordinates: the like button is clicked on the PC client right rail automatically; the web player is liked by double-clicking the video. Pass layout.like / layout.comment / layout.open to override, using the relative (0..1) points that action "calibrate" measures from the live pointer.',
].join(' ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the logger without assuming the service is mounted. */
function safeLogger(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('logger') : undefined;
  } catch {
    return undefined;
  }
}

/** Clamp a numeric argument, falling back to a default. */
function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
  },
};

const ENVELOPE = {
  action: { type: 'string', required: true, description: 'The action that ran.' },
  ok: { type: 'boolean', required: true, description: 'Whether the action completed.' },
  text: { type: 'string', required: true, description: 'Human-readable result.' },
  data: {
    type: 'object',
    additionalProperties: true,
    description: 'Action-specific result data, shaped exactly as the action documents.',
  },
  shot: { ...SHOT_SCHEMA, description: 'Screenshot written by this call, when it produced one.' },
};

const presentCallFor = (title) => (args) => ({
  card: 'generic',
  title: typeof title === 'function' ? title(args) : title,
  kind: 'execute',
  rawInput: args,
});

/**
 * Register the tools on one context.
 * @param {object} ctx - Cordis context with the `tools` service
 * @param {object} config - validated plugin configuration
 */
export function apply(ctx, config) {
  const cfg = {
    screenshotMaxWidth: Math.max(320, Math.round(num(config?.screenshotMaxWidth, 1280))),
    agentTimeoutMs: Math.max(2000, Math.round(num(config?.agentTimeoutMs, 20000))),
    outputDir: typeof config?.outputDir === 'string' && config.outputDir.trim().length > 0 ? config.outputDir.trim() : join(tmpdir(), 'dsh-pc-control'),
    douyinUrl: config?.douyinUrl ?? 'https://www.douyin.com/',
    douyinWindowTitle: config?.douyinWindowTitle ?? '抖音',
    maxWatchCount: Math.round(num(config?.maxWatchCount, 20)),
    minDwellMs: Math.round(num(config?.minDwellMs, 3000)),
    maxDwellMs: Math.round(num(config?.maxDwellMs, 12000)),
    likeChance: num(config?.likeChance, 0.2),
    maxLikesPerRun: Math.round(num(config?.maxLikesPerRun, 5)),
    openTimeoutMs: Math.round(num(config?.openTimeoutMs, 25000)),
  };

  const logger = safeLogger(ctx);
  const agent = new PcAgent({ rootDir: cfg.outputDir, logger, timeoutMs: cfg.agentTimeoutMs });
  const douyin = createDouyin({ agent, config: cfg, logger });

  ctx.effect(() => () => {
    agent.dispose().catch((error) => logger?.warn?.(`computer-use: failed to stop the desktop agent: ${String(error)}`));
  });

  const envelope = (action, text, data = {}, shot) => ({
    action,
    ok: true,
    text,
    data,
    ...(shot ? { shot: { path: shot.path, width: shot.width, height: shot.height } } : {}),
  });

  async function screenshot(args, signal) {
    const mode = args.mode ?? 'screen';
    const params = { mode, max_width: Math.round(num(args.max_width, cfg.screenshotMaxWidth)) };
    if (mode === 'window') {
      if (args.window !== undefined) params.window = args.window;
    } else if (mode === 'region') {
      if (![args.x, args.y, args.width, args.height].every((value) => Number.isFinite(value))) {
        throw new Error('screenshot with mode "region" needs numeric x, y, width and height');
      }
      params.x = Math.round(args.x);
      params.y = Math.round(args.y);
      params.width = Math.round(args.width);
      params.height = Math.round(args.height);
    }
    const result = await agent.call('screenshot', params, { signal, timeoutMs: 30000 });
    const text = `Saved a ${result.width}x${result.height} ${result.mode} screenshot to ${result.path}. Use read_image on that path to look at it.`;
    return envelope('screenshot', text, result, result);
  }

  const computerTool = defineTool({
    name: 'computer',
    description: COMPUTER_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: COMPUTER_ACTIONS,
        description: [
          'screen_info (display metrics, cursor, foreground window)',
          'screenshot (mode: screen|window|region)',
          'cursor (pointer position and foreground window)',
          'move (x, y, duration_ms)',
          'click (x?, y?, button, count, interval_ms)',
          'drag (x1, y1, x2, y2, duration_ms, button)',
          'scroll (x?, y?, delta, times, interval_ms; negative delta scrolls down)',
          'type (text; synthesizes Unicode characters directly)',
          'key (key name, times)',
          'hotkey (keys array, e.g. ["ctrl","shift","esc"])',
          'windows (filter?)',
          'focus (window: hwnd or title substring)',
          'launch (target: URL or executable, args?)',
          'clipboard_get',
          'clipboard_set (text)',
          'wait (ms, capped at 60000; the kill switch is polled while waiting)',
          'panic / resume (raise or clear the kill switch)',
        ].join('; '),
      },
      x: { type: 'number', description: 'Primary-monitor pixel X for move/click/scroll/screenshot-region.' },
      y: { type: 'number', description: 'Primary-monitor pixel Y for move/click/scroll/screenshot-region.' },
      x1: { type: 'number', description: 'Drag start X.' },
      y1: { type: 'number', description: 'Drag start Y.' },
      x2: { type: 'number', description: 'Drag end X.' },
      y2: { type: 'number', description: 'Drag end Y.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click/drag; defaults to left.' },
      count: { type: 'integer', description: 'Click count (1 = single, 2 = double). Defaults to 1.' },
      duration_ms: { type: 'number', description: 'Movement/drag duration in milliseconds; 0 jumps instantly.' },
      interval_ms: { type: 'integer', description: 'Delay between repeated clicks/keys or wheel notches, in milliseconds.' },
      delta: { type: 'integer', description: 'Wheel delta per notch; -120 scrolls down, 120 scrolls up.' },
      times: { type: 'integer', description: 'Repeat count for scroll/key, capped at 20.' },
      text: { type: 'string', description: 'Text for type/clipboard_set.' },
      key: { type: 'string', description: 'Key name for key, e.g. enter, tab, esc, space, left, up, f5, a, 1.' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Key names pressed together, modifiers first.' },
      window: { type: 'string', description: 'Window handle (decimal) or a title substring; defaults to the foreground window for screenshots.' },
      filter: { type: 'string', description: 'Only list windows whose title contains this text.' },
      target: { type: 'string', description: 'URL or executable to launch.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments for launch.' },
      mode: { type: 'string', enum: ['screen', 'window', 'region'], description: 'Screenshot source; defaults to screen.' },
      width: { type: 'integer', description: 'Screenshot region width.' },
      height: { type: 'integer', description: 'Screenshot region height.' },
      max_width: { type: 'integer', description: 'Longest edge of the saved image; defaults to the plugin configuration.' },
      ms: { type: 'integer', description: 'Milliseconds for wait, capped at 60000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: ENVELOPE,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: presentCallFor((args) => `computer: ${args.action}`),
    presentResult: (_args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined;
      if (block?.type !== 'text') return undefined;
      return { card: 'generic', content: [{ type: 'text', text: block.text }] };
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const signal = exec.signal;
      switch (args.action) {
        case 'screen_info': {
          const data = await agent.call('screen_info', {}, { signal });
          const foreground = data.foreground?.title ? ` Foreground window: "${data.foreground.title}".` : '';
          return envelope('screen_info', `Screen ${data.width}x${data.height} (${data.monitors ?? 1} monitor(s), DPI-aware: ${data.dpiAware}). Cursor at ${data.cursor?.x},${data.cursor?.y}.${foreground}`, data);
        }
        case 'screenshot':
          return screenshot(args, signal);
        case 'cursor': {
          const data = await agent.call('cursor', {}, { signal });
          return envelope('cursor', `Cursor at ${data.x},${data.y}. Foreground window: "${data.foreground?.title ?? '(none)'}".`, data);
        }
        case 'move': {
          if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new Error('move needs numeric x and y');
          const data = await agent.call('move', { x: Math.round(args.x), y: Math.round(args.y), duration_ms: num(args.duration_ms, 0) }, { signal });
          return envelope('move', `Moved the pointer to ${data.x},${data.y}.`, data);
        }
        case 'click': {
          const params = {
            button: args.button ?? 'left',
            count: Math.round(num(args.count, 1)),
            interval_ms: Math.round(num(args.interval_ms, 90)),
          };
          if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
            params.x = Math.round(args.x);
            params.y = Math.round(args.y);
          }
          const data = await agent.call('click', params, { signal });
          return envelope('click', `Clicked ${data.count}x ${data.button} at ${data.x},${data.y}.`, data);
        }
        case 'drag': {
          if (![args.x1, args.y1, args.x2, args.y2].every((value) => Number.isFinite(value))) {
            throw new Error('drag needs numeric x1, y1, x2, y2');
          }
          const data = await agent.call('drag', {
            x1: Math.round(args.x1),
            y1: Math.round(args.y1),
            x2: Math.round(args.x2),
            y2: Math.round(args.y2),
            button: args.button ?? 'left',
            duration_ms: Math.round(num(args.duration_ms, 400)),
          }, { signal });
          return envelope('drag', `Dragged from ${data.from.x},${data.from.y} to ${data.to.x},${data.to.y}.`, data);
        }
        case 'scroll': {
          if (!Number.isFinite(args.delta ?? args.times)) throw new Error('scroll needs delta or times');
          const params = {
            delta: Math.round(num(args.delta, -120)),
            times: Math.min(20, Math.max(1, Math.round(num(args.times, 1)))),
            interval_ms: Math.round(num(args.interval_ms, 60)),
          };
          if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
            params.x = Math.round(args.x);
            params.y = Math.round(args.y);
          }
          const data = await agent.call('scroll', params, { signal });
          return envelope('scroll', `Scrolled ${data.delta >= 0 ? 'up' : 'down'} ${data.times} notch(es).`, data);
        }
        case 'type': {
          if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('type needs a non-empty text');
          if (args.text.length > 2000) throw new Error('type is limited to 2000 characters per call');
          const data = await agent.call('type', { text: args.text, interval_ms: Math.round(num(args.interval_ms, 0)) }, { signal, timeoutMs: 15000 + args.text.length * 40 });
          return envelope('type', `Typed ${data.chars} character(s) into the focused control.`, data);
        }
        case 'key': {
          if (typeof args.key !== 'string' || args.key.length === 0) throw new Error('key needs a key name');
          const times = Math.min(20, Math.max(1, Math.round(num(args.times, 1))));
          const data = await agent.call('key', { key: args.key, times, interval_ms: Math.round(num(args.interval_ms, 60)) }, { signal });
          return envelope('key', `Pressed ${args.key} ${data.times}x.`, data);
        }
        case 'hotkey': {
          if (!Array.isArray(args.keys) || args.keys.length === 0 || args.keys.length > 4) {
            throw new Error('hotkey needs 1-4 key names in `keys`');
          }
          const data = await agent.call('hotkey', { keys: args.keys }, { signal });
          return envelope('hotkey', `Pressed ${args.keys.join('+')}.`, data);
        }
        case 'windows': {
          const data = await agent.call('windows', args.filter ? { filter: args.filter } : {}, { signal });
          const rows = data.windows ?? [];
          const listing = rows.slice(0, 40).map((win) => `- [${win.hwnd}] "${win.title}" ${win.width}x${win.height} at ${win.x},${win.y}${win.foreground ? ' (foreground)' : ''}`).join('\n');
          return envelope('windows', `${rows.length} visible window(s)${args.filter ? ` matching "${args.filter}"` : ''}:\n${listing || '(none)'}`, data);
        }
        case 'focus': {
          if (typeof args.window !== 'string' && !Number.isFinite(args.window)) throw new Error('focus needs a window handle or title substring');
          const data = await agent.call('focus', { window: String(args.window) }, { signal });
          const text = data.activated
            ? `Focused "${data.active.title}" (${data.active.width}x${data.active.height} at ${data.active.x},${data.active.y}).`
            : `Windows refused to focus "${data.requested.title}"; it is still not the foreground window. Ask the user to click it once.`;
          return envelope('focus', text, data);
        }
        case 'launch': {
          if (typeof args.target !== 'string' || args.target.trim().length === 0) throw new Error('launch needs a target URL or executable');
          const data = await agent.call('launch', { target: args.target, args: Array.isArray(args.args) ? args.args : [] }, { signal });
          return envelope('launch', `Started ${data.target}${data.args.length > 0 ? ` with ${data.args.length} argument(s)` : ''}.`, data);
        }
        case 'clipboard_get': {
          const data = await agent.call('clipboard_get', {}, { signal });
          return envelope('clipboard_get', `Clipboard holds ${data.length} character(s):\n${data.text}`, data);
        }
        case 'clipboard_set': {
          if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('clipboard_set needs non-empty text');
          const data = await agent.call('clipboard_set', { text: args.text }, { signal });
          return envelope('clipboard_set', `Copied ${data.length} character(s) to the clipboard.`, data);
        }
        case 'wait': {
          const ms = Math.min(60000, Math.max(0, Math.round(num(args.ms, 0))));
          const data = await agent.call('wait', { ms }, { signal, timeoutMs: ms + 15000 });
          return envelope('wait', `Waited ${ms}ms.`, data);
        }
        case 'panic': {
          const data = await agent.call('panic', {}, { signal });
          return envelope('panic', 'Kill switch raised: all further synthesized input is refused until action "resume".', data);
        }
        case 'resume': {
          const data = await agent.call('resume', {}, { signal });
          return envelope('resume', 'Kill switch cleared: desktop input is allowed again.', data);
        }
        default:
          throw new Error(`unsupported computer action: ${args.action}`);
      }
    },
  });

  const douyinTool = defineTool({
    name: 'douyin',
    description: DOUYIN_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: DOUYIN_ACTIONS,
        description: [
          'status (is a Douyin window open, is it focused, where is the pointer; pass screenshot: true to see it)',
          'open (launch the site and wait for its window)',
          'enter (PC client: click the first video card to open the player)',
          'next / prev (swipe one or more videos)',
          'like (like the current video)',
          'pause / play (Space)',
          'watch (dwell, optionally like, swipe — for a batch)',
          'comment (needs confirm: true and the approved text)',
          'calibrate (measure the pointer position relative to the window)',
          'stop (raise the panic flag)',
        ].join('; '),
      },
      count: { type: 'integer', description: 'Videos to watch in one "watch" batch (1-50, default from config).' },
      times: { type: 'integer', description: 'Swipes for next/prev (1-20).' },
      method: { type: 'string', enum: ['wheel', 'key'], description: 'How to swipe: mouse wheel (default) or ArrowDown/ArrowUp.' },
      min_dwell_ms: { type: 'integer', description: 'Shortest dwell per video in a watch batch.' },
      max_dwell_ms: { type: 'integer', description: 'Longest dwell per video in a watch batch.' },
      like_chance: { type: 'number', description: '0..0.8 probability of liking a video during watch; 0 disables likes.' },
      max_likes: { type: 'integer', description: 'Cap on likes inside one watch batch (0-10).' },
      screenshot_every: { type: 'integer', description: 'Save one window screenshot every N videos (0 disables screenshots).' },
      text: { type: 'string', description: 'Exact comment text approved by the user (comment action, max 120 chars).' },
      confirm: { type: 'boolean', description: 'Must be true to post a comment. Only set it after the user approved this exact text.' },
      screenshot: { type: 'boolean', description: 'For status: also capture a window screenshot so a login wall or captcha is visible.' },
      enter: { type: 'boolean', description: 'For watch: click the first video card first (needed when the PC client shows its grid).' },
      url: { type: 'string', description: 'Override the URL opened by "open".' },
      layout: {
        type: 'object',
        additionalProperties: false,
        description: 'Relative (0..1) points inside the window for the player and the action buttons.',
        properties: {
          center: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
          },
          like: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
          },
          comment: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
          },
          open: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...ENVELOPE,
          videos: { type: 'integer', description: 'Videos watched in this call.' },
          likes: { type: 'integer', description: 'Likes given in this call.' },
          stopped: { type: 'string', description: 'Why a batch stopped early, when it did.' },
          shots: { type: 'array', items: { type: 'string' }, description: 'Screenshots saved during this call.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: presentCallFor((args) => `douyin: ${args.action}`),
    presentResult: (_args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined;
      if (block?.type !== 'text') return undefined;
      return { card: 'generic', content: [{ type: 'text', text: block.text }] };
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { signal } = exec;
      try {
        if (args.action === 'watch') {
          const result = await douyin.run('watch', { ...args, signal });
          return {
            action: 'watch',
            ok: true,
            text: result.text,
            data: { videos: result.videos, likes: result.likes, shots: result.shots, stopped: result.stopped ?? null },
            ...(Number.isFinite(result.videos) ? { videos: result.videos } : {}),
            ...(Number.isFinite(result.likes) ? { likes: result.likes } : {}),
            ...(result.stopped ? { stopped: result.stopped } : {}),
            ...(result.shots?.length ? { shots: result.shots } : {}),
          };
        }
        const result = await douyin.run(args.action, args);
        return {
          action: args.action,
          ok: true,
          text: result.text,
          data: result,
          ...(result.shot ? { shot: { path: result.shot.path, width: result.shot.width, height: result.shot.height } } : {}),
        };
      } catch (error) {
        if (error instanceof DouyinError) throw new Error(error.message);
        if (error instanceof PcAgentError) {
          if (error.code === 'KILL_SWITCH') {
            throw new Error('Stopped by the user\'s kill switch (Ctrl+Alt+Shift+Q). Call `computer` action "resume" only after the user asks to continue.');
          }
          throw new Error(`Douyin action failed: ${error.message}`);
        }
        throw error;
      }
    },
  });

  ctx.tools.register(computerTool);
  ctx.tools.register(douyinTool);

  logger?.info?.('computer-use: desktop control tools registered (screenshot, mouse, keyboard, windows, Douyin)');
}

export { sleep };
