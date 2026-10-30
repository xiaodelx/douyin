/**
 * Douyin (抖音) feed driver on top of the desktop agent.
 *
 * Two targets are supported with one API:
 *   - the Douyin PC client (window title exactly "抖音"), whose home page is a
 *     grid and whose player is opened by clicking a card, then advanced with
 *     ArrowDown / ArrowUp;
 *   - the web player (a browser window titled "... 抖音 ..."), advanced with
 *     the mouse wheel.
 *
 * The controller only synthesizes the same input a person would: focus the
 * window, move the pointer, scroll or press a key, dwell, occasionally click
 * the like button. It never reads cookies, calls private APIs, or posts
 * content without an explicit `confirm` from the caller.
 *
 * @module dsh-plugin-computer-use/douyin
 */
import { PcAgentError } from './agent-client.js';

/** Expected, model-actionable failure (no window, missing calibration, ...). */
export class DouyinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DouyinError';
  }
}

/** Window titles that mean "this is a browser tab, not the PC client". */
const BROWSER_TITLE = /chrome|edge|firefox|brave|opera|vivaldi|safari|360|qq浏览器|搜狗|uc浏览器|chromium/i;

/**
 * The PC client draws its action rail a fixed distance from the right edge, so
 * pixel offsets survive window resizes better than relative points do.
 * Measured against the client's player view at 1730x997 (October 2026 build);
 * `layout.like` / `layout.comment` override these.
 */
const CLIENT_RAIL = { rightPx: 123, likeRatio: 0.47, commentRatio: 0.54, openRatio: [0.26, 0.30] };

const DEFAULT_CENTER = [0.5, 0.55];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** A window has to be on screen and big enough to be the real Douyin surface. */
function isUsable(win) {
  return win.width >= 480 && win.height >= 320 && win.x > -10000 && win.y > -10000;
}

const sleepAgent = async (agent, ms) => {
  if (ms <= 0) return {};
  return agent.call('wait', { ms: Math.round(ms) }, { timeoutMs: ms + 15000 });
};

/**
 * Build the Douyin controller bound to one agent and one configuration.
 * @param {object} deps
 * @param {import('./agent-client.js').PcAgent} deps.agent
 * @param {object} deps.config - normalized plugin configuration
 * @param {{info?: Function, warn?: Function}} [deps.logger]
 */
export function createDouyin({ agent, config, logger }) {
  const titles = [config.douyinWindowTitle, '抖音', 'douyin'].filter((title) => typeof title === 'string' && title.length > 0);
  const log = (message) => logger?.info?.(`computer-use/douyin: ${message}`);

  // The plugin runs inside the DSH host process, and chat titles often contain
  // "抖音"; driving our own window would be a self-inflicted click storm.
  const selfPid = typeof process !== 'undefined' ? process.pid : -1;

  /**
   * A window counts as Douyin when its title either starts with the keyword
   * (the PC client) or is a browser tab that contains it (the web player).
   * The floating widget ("抖音挂件") and menu popups are rejected by the
   * minimum-size check instead of by name.
   */
  const matches = (win) => {
    if (win.pid === selfPid) return false;
    const title = win.title.trim();
    if (/deepseek harness/i.test(title)) return false;
    const lower = title.toLowerCase();
    if (!titles.some((candidate) => lower.includes(candidate.toLowerCase()))) return false;
    return BROWSER_TITLE.test(title) || titles.some((candidate) => lower.startsWith(candidate.toLowerCase()));
  };

  /** Every window whose title looks like Douyin, on screen or minimized. */
  async function candidates() {
    const result = await agent.call('windows', {});
    return (result.windows ?? []).filter(matches);
  }

  /** The visible Douyin window, preferring the largest match. */
  async function findWindow() {
    const all = await candidates();
    const usable = all.filter(isUsable).sort((a, b) => b.width * b.height - a.width * a.height);
    return usable[0] ?? null;
  }

  async function requireWindow() {
    const win = await findWindow();
    if (win) return win;
    const all = await candidates();
    const minimized = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (minimized) {
      // The PC client collapses into a floating widget / tray icon when closed
      // to tray; a restore is worth one try before asking the user.
      log(`trying to restore minimized window ${minimized.hwnd} "${minimized.title}"`);
      await agent.call('focus', { window: String(minimized.hwnd) });
      await sleepAgent(agent, 900);
      const restored = await findWindow();
      if (restored) return restored;
      throw new DouyinError(
        `The Douyin window "${minimized.title}" is minimized to its floating widget or tray (${minimized.width}x${minimized.height}). Ask the user to restore the main window (click the tray icon), then retry.`,
      );
    }
    throw new DouyinError(
      'No Douyin window is open. Call the `douyin` tool with action "open" first, or open https://www.douyin.com/ in a browser yourself.',
    );
  }

  /** Bring the Douyin window to the foreground and return its live rectangle. */
  async function focusWindow() {
    const win = await requireWindow();
    const cursor = await agent.call('cursor', {});
    if (cursor.foreground?.hwnd === win.hwnd) {
      const info = await agent.call('window_info', { window: String(win.hwnd) });
      return { ...win, ...info };
    }
    const focused = await agent.call('focus', { window: String(win.hwnd) });
    await sleepAgent(agent, 240);
    if (!focused.activated) {
      throw new DouyinError(
        `Could not bring the Douyin window "${win.title}" to the foreground; Windows refused the focus request. Ask the user to click the window once, then retry.`,
      );
    }
    const info = await agent.call('window_info', { window: String(win.hwnd) });
    return { ...win, ...info };
  }

  /** Which surface the window hosts, which decides the swipe mechanism. */
  const targetKind = (win) => (BROWSER_TITLE.test(win.title) ? 'web' : 'client');

  function layoutWith(overrides) {
    const merged = { center: DEFAULT_CENTER, like: null, comment: null, open: null };
    for (const key of ['center', 'like', 'comment', 'open']) {
      const custom = overrides?.[key];
      if (custom && Number.isFinite(custom.x) && Number.isFinite(custom.y)) merged[key] = [custom.x, custom.y];
    }
    return merged;
  }

  function pointOf(win, vector, jitterRatio = 0.01) {
    const jx = (Math.random() * 2 - 1) * jitterRatio;
    const jy = (Math.random() * 2 - 1) * jitterRatio;
    const rx = clamp(vector[0] + jx, 0.02, 0.98);
    const ry = clamp(vector[1] + jy, 0.02, 0.98);
    return {
      x: Math.round(win.x + win.width * rx),
      y: Math.round(win.y + win.height * ry),
      rx: Number(rx.toFixed(4)),
      ry: Number(ry.toFixed(4)),
    };
  }

  async function run(action, args = {}) {
    switch (action) {
      case 'status':
        return status(args);
      case 'open':
        return open(args);
      case 'enter':
        return enter(args);
      case 'next':
      case 'prev':
        return swipe(action, args);
      case 'like':
        return like(args);
      case 'pause':
      case 'play':
        return pressSpace(action);
      case 'comment':
        return comment(args);
      case 'watch':
        return watch(args);
      case 'calibrate':
        return calibrate(args);
      case 'stop':
        return stop();
      default:
        throw new DouyinError(`unknown douyin action: ${action}`);
    }
  }

  async function status(args = {}) {
    const win = await findWindow();
    if (!win) {
      const hidden = (await candidates()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return {
        running: false,
        minimized: hidden !== undefined,
        text: hidden
          ? `A Douyin window exists but is not usable (${hidden.width}x${hidden.height}, title "${hidden.title}") — the PC client is probably collapsed into its floating widget or tray. Ask the user to restore the main window, then retry; any driving action would try once to restore it.`
          : 'No visible Douyin window found. Use action "open" to start the web feed, or restore the PC client from its tray icon.',
      };
    }
    const cursor = await agent.call('cursor', {});
    const relative = {
      x: Number(((cursor.x - win.x) / Math.max(1, win.width)).toFixed(4)),
      y: Number(((cursor.y - win.y) / Math.max(1, win.height)).toFixed(4)),
    };
    const shot = args.screenshot === true
      ? await agent.call('screenshot', { mode: 'window', window: String(win.hwnd), max_width: config.screenshotMaxWidth })
      : undefined;
    const focused = cursor.foreground?.hwnd === win.hwnd;
    return {
      running: true,
      kind: targetKind(win),
      window: win,
      foreground: focused,
      cursor: { x: cursor.x, y: cursor.y, relative },
      shot,
      text: [
        `Douyin ${targetKind(win) === 'client' ? 'PC client' : 'web player'} window "${win.title}" at ${win.x},${win.y} ${win.width}x${win.height}; ${focused ? 'in the foreground' : 'NOT in the foreground'}.`,
        targetKind(win) === 'client' ? 'If it shows the grid, call action "enter" to open a video before watching.' : '',
        shot ? `Screenshot: ${shot.path} — check it for a login wall, captcha, or an unexpected layout before driving the feed.` : '',
      ].filter(Boolean).join(' '),
    };
  }

  async function open(args) {
    const url = args.url ?? config.douyinUrl;
    const existing = await findWindow();
    if (existing) {
      const focused = await focusWindow();
      return { window: focused, opened: false, text: `Douyin is already open; focused "${focused.title}".` };
    }
    await agent.call('launch', { target: url });
    log(`launched ${url}`);
    const deadline = Date.now() + config.openTimeoutMs;
    while (Date.now() < deadline) {
      await sleepAgent(agent, 800);
      const win = await findWindow();
      if (win) {
        const focused = await focusWindow();
        await sleepAgent(agent, 1200);
        return { window: focused, opened: true, text: `Opened ${url} and focused "${focused.title}".` };
      }
    }
    throw new DouyinError(
      `Launched ${url} but no window whose title contains "${config.douyinWindowTitle}" appeared within ${config.openTimeoutMs}ms. The browser may still be loading, may show a login wall, or may be using a different window title; check with the \`computer\` tool (action "windows").`,
    );
  }

  /** Open the first video of the PC client's grid. */
  async function enter(args) {
    const win = await focusWindow();
    const layout = layoutWith(args.layout);
    const point = layout.open ? pointOf(win, layout.open, 0.01) : pointOf(win, CLIENT_RAIL.openRatio, 0.01);
    await agent.call('click', { x: point.x, y: point.y, button: 'left', count: 1 });
    await sleepAgent(agent, 1600 + Math.round(Math.random() * 800));
    return {
      window: win,
      point,
      text: `Clicked the first video card at ${point.x},${point.y} to open the player. Check with action "status" (screenshot: true) or "watch" that a video is now showing.`,
    };
  }

  async function swipe(direction, args) {
    const times = clamp(args.times ?? 1, 1, 20);
    const win = await focusWindow();
    const kind = targetKind(win);
    const method = args.method ?? (kind === 'client' ? 'key' : 'wheel');
    const layout = layoutWith(args.layout);

    if (method === 'key') {
      const key = direction === 'next' ? 'down' : 'up';
      for (let i = 0; i < times; i++) {
        await agent.call('key', { key, times: 1, interval_ms: 40 });
        // The PC client shows a "加载中" splash while the next video buffers.
        await sleepAgent(agent, (kind === 'client' ? 1500 : 350) + Math.round(Math.random() * 400));
      }
    } else {
      const point = pointOf(win, layout.center);
      const delta = direction === 'next' ? -120 : 120;
      await agent.call('scroll', { x: point.x, y: point.y, delta, times, interval_ms: 90 });
      await sleepAgent(agent, 300 + Math.round(Math.random() * 250));
    }
    return {
      window: win,
      kind,
      times,
      method,
      text: `Moved ${direction === 'next' ? 'to the next' : 'to the previous'} video (${times}x, ${method === 'key' ? (direction === 'next' ? 'ArrowDown' : 'ArrowUp') : 'mouse wheel'}).${kind === 'client' && method === 'key' ? ' On the grid ArrowDown does nothing — use action "enter" first.' : ''}`,
    };
  }

  async function like(args) {
    const layout = layoutWith(args.layout);
    const win = await focusWindow();
    let point;
    let how;
    if (layout.like) {
      point = pointOf(win, layout.like);
      how = 'clicked the calibrated like button';
    } else if (targetKind(win) === 'client') {
      point = {
        x: Math.round(win.x + win.width - CLIENT_RAIL.rightPx),
        y: Math.round(win.y + win.height * CLIENT_RAIL.likeRatio),
      };
      how = 'clicked the like button on the right rail';
    } else {
      point = pointOf(win, layout.center, 0.02);
      how = 'double-clicked the video (web player)';
      await agent.call('click', { x: point.x, y: point.y, button: 'left', count: 2, interval_ms: 90 });
      await sleepAgent(agent, 320 + Math.round(Math.random() * 240));
      return { window: win, point, text: `Liked the current video (${how} at ${point.x},${point.y}). Confirm visually before trusting it.` };
    }
    await agent.call('click', { x: point.x, y: point.y, button: 'left', count: 1 });
    await sleepAgent(agent, 320 + Math.round(Math.random() * 240));
    return { window: win, point, text: `Liked the current video (${how} at ${point.x},${point.y}). Confirm visually before trusting it.` };
  }

  async function pressSpace(action) {
    const win = await focusWindow();
    await agent.call('key', { key: 'space', times: 1 });
    await sleepAgent(agent, 260);
    return { window: win, text: `${action === 'pause' ? 'Paused' : 'Resumed'} the current video with Space.` };
  }

  async function comment(args) {
    if (args.confirm !== true) {
      throw new DouyinError(
        'Posting a comment needs explicit confirmation: call again with confirm: true once the user approved the exact text. Never comment on the user\'s behalf otherwise.',
      );
    }
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (text.length === 0) throw new DouyinError('comment needs a non-empty `text`.');
    if (text.length > 120) throw new DouyinError('comment text is limited to 120 characters.');
    const layout = layoutWith(args.layout);
    const win = await focusWindow();
    let point = layout.comment ? pointOf(win, layout.comment) : null;
    if (!point) {
      if (targetKind(win) !== 'client') {
        throw new DouyinError(
          'The comment button is not calibrated. Ask the user to hover the pointer over the comment icon, call action "calibrate", then pass layout.comment as {x,y} relative coordinates (0..1).',
        );
      }
      point = {
        x: Math.round(win.x + win.width - CLIENT_RAIL.rightPx),
        y: Math.round(win.y + win.height * CLIENT_RAIL.commentRatio),
      };
    }
    await agent.call('click', { x: point.x, y: point.y, button: 'left', count: 1 });
    await sleepAgent(agent, 900);
    await agent.call('type', { text, interval_ms: 35 });
    await sleepAgent(agent, 500);
    await agent.call('key', { key: 'enter', times: 1 });
    await sleepAgent(agent, 700);
    return { window: win, point, text: `Posted the comment ${JSON.stringify(text)}. Verify it appeared before reporting success.` };
  }

  async function calibrate() {
    const win = await requireWindow();
    const cursor = await agent.call('cursor', {});
    const relative = {
      x: Number(((cursor.x - win.x) / Math.max(1, win.width)).toFixed(4)),
      y: Number(((cursor.y - win.y) / Math.max(1, win.height)).toFixed(4)),
    };
    const shot = await agent.call('screenshot', { mode: 'window', window: String(win.hwnd), max_width: config.screenshotMaxWidth });
    return {
      window: win,
      kind: targetKind(win),
      cursor: { x: cursor.x, y: cursor.y, relative },
      shot,
      text: `Pointer is at relative (${relative.x}, ${relative.y}) inside the Douyin window. Screenshot: ${shot.path}. Hover the control to calibrate and read its relative point the same way.`,
    };
  }

  async function stop() {
    await agent.call('panic', {});
    return { text: 'Panic flag set: every further synthesized input is refused until action "resume" (the `computer` tool) is called. The user can also hold Ctrl+Alt+Shift+Q to raise the same flag.' };
  }

  async function watch(args) {
    const count = clamp(Math.round(args.count ?? config.maxWatchCount), 1, 50);
    const minDwell = clamp(Math.round(args.min_dwell_ms ?? config.minDwellMs), 600, 60000);
    const maxDwell = clamp(Math.round(args.max_dwell_ms ?? Math.max(minDwell, config.maxDwellMs)), minDwell, 120000);
    const likeChance = clamp(Number(args.like_chance ?? config.likeChance), 0, 0.8);
    const maxLikes = clamp(Math.round(args.max_likes ?? config.maxLikesPerRun), 0, 10);
    const screenshotEvery = clamp(Math.round(args.screenshot_every ?? 0), 0, 50);
    const budgetMs = Math.min(8 * 60 * 1000, count * (maxDwell + 3000));

    let videos = 0;
    let likes = 0;
    let kind = 'unknown';
    const shots = [];
    let stopped = null;
    const startedAt = Date.now();

    if (args.enter === true) {
      await enter(args);
    }

    for (let i = 0; i < count; i++) {
      try {
        const win = await focusWindow();
        kind = targetKind(win);
        await sleepAgent(agent, Math.round(minDwell + Math.random() * (maxDwell - minDwell)));
        if (likeChance > 0 && likes < maxLikes && Math.random() < likeChance) {
          await like(args);
          likes += 1;
        }
        if (screenshotEvery > 0 && i % screenshotEvery === 0) {
          const shot = await agent.call('screenshot', { mode: 'window', window: String(win.hwnd), max_width: config.screenshotMaxWidth });
          shots.push(shot.path);
        }
        await swipe('next', { ...args, times: 1 });
        videos += 1;
      } catch (error) {
        if (error instanceof PcAgentError && error.code === 'KILL_SWITCH') {
          stopped = 'kill switch or panic';
          break;
        }
        throw error;
      }
      if (Date.now() - startedAt > budgetMs) {
        stopped = `time budget of ${Math.round(budgetMs / 1000)}s reached`;
        break;
      }
    }

    // One closing screenshot lets the caller verify what the feed actually did
    // (a login wall, a captcha, a grid that never opened, or a paused player).
    try {
      const win = await requireWindow();
      const shot = await agent.call('screenshot', { mode: 'window', window: String(win.hwnd), max_width: config.screenshotMaxWidth });
      shots.push(shot.path);
    } catch (error) {
      log(`final screenshot skipped: ${String(error)}`);
    }

    const summary = [
      `Watched ${videos} video(s) on the ${kind === 'client' ? 'PC client' : kind === 'web' ? 'web player' : 'Douyin window'} (${Math.round((Date.now() - startedAt) / 1000)}s total).`,
      likes > 0 ? `Liked ${likes}.` : 'Did not like anything.',
      stopped ? `Stopped early: ${stopped}.` : '',
      shots.length > 0 ? `Screenshots: ${shots.join(', ')} — look at the last one to confirm the feed really advanced; a login wall, a captcha, or the client grid would leave it unchanged.` : '',
    ].filter(Boolean).join(' ');

    return { videos, likes, shots, stopped, text: summary };
  }

  return { findWindow, run, status, calibrate };
}
