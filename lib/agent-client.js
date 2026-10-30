/**
 * Client for the persistent PowerShell desktop agent (`agent.ps1`).
 *
 * The agent is a JSON-line request/response server over stdin/stdout. One
 * process per plugin instance keeps Win32 state (DPI awareness, panic flag)
 * and makes each action cost a few milliseconds instead of a PowerShell
 * cold start. A crashed or hung agent is replaced on the next call.
 *
 * @module dsh-plugin-computer-use/agent-client
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = join(HERE, 'agent.ps1');
const READY_ID = 0;

/** Failure raised by the desktop agent, carrying its machine-readable code. */
export class PcAgentError extends Error {
  /**
   * @param {string} message - human-readable failure
   * @param {string} [code] - agent code such as `KILL_SWITCH` or `ERROR`
   */
  constructor(message, code = 'ERROR') {
    super(message);
    this.name = 'PcAgentError';
    this.code = code;
  }
}

export class PcAgent {
  #script;
  #root;
  #logger;
  #child = null;
  #ready = null;
  #pending = new Map();
  #seq = 0;
  #buffer = '';
  #stderr = '';
  #disposed = false;
  #timeoutMs;

  /**
   * @param {object} [options]
   * @param {string} [options.scriptPath] - absolute path to agent.ps1
   * @param {string} [options.rootDir] - directory for agent state and screenshots
   * @param {{info: Function, warn: Function}} [options.logger] - DSH logger
   * @param {number} [options.timeoutMs] - default per-request timeout
   */
  constructor(options = {}) {
    this.#script = options.scriptPath ?? DEFAULT_SCRIPT;
    this.#root = options.rootDir ?? join(tmpdir(), 'dsh-pc-control');
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 20000;
  }

  get rootDir() {
    return this.#root;
  }

  /**
   * Start the agent if it is not already serving requests.
   * @returns {Promise<void>} resolves once the agent printed its ready line
   */
  async start() {
    if (this.#disposed) throw new PcAgentError('the desktop agent was disposed');
    if (this.#ready) return this.#ready;
    this.#ready = this.#spawn();
    try {
      await this.#ready;
    } catch (error) {
      this.#ready = null;
      throw error;
    }
  }

  async #spawn() {
    if (this.#child) {
      try { this.#child.kill(); } catch { /* already gone */ }
      this.#child = null;
    }
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', this.#script, '-Root', this.#root],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.#child = child;
    this.#buffer = '';
    this.#stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-8000);
    });
    child.on('exit', (code, signal) => this.#onExit(code, signal));
    child.on('error', (error) => {
      this.#rejectAll(new PcAgentError(`desktop agent failed to start: ${error.message}`));
      this.#child = null;
      this.#ready = null;
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        reject(new PcAgentError(`desktop agent did not become ready within ${this.#timeoutMs}ms`));
      }, Math.max(5000, this.#timeoutMs));
      this.#onReady = () => {
        clearTimeout(timer);
        this.#onReady = null;
        resolve();
      };
      this.#onReadyFailed = (error) => {
        clearTimeout(timer);
        this.#onReady = null;
        this.#onReadyFailed = null;
        reject(error);
      };
    });
  }

  #onReady = null;

  #onReadyFailed = null;

  #onStdout(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#logger?.warn?.(`computer-use: ignoring non-JSON agent output: ${line.slice(0, 300)}`);
      return;
    }
    if (message.id === READY_ID) {
      if (message.ok) this.#onReady?.();
      else this.#onReadyFailed?.(new PcAgentError(message.error ?? 'desktop agent failed to initialize'));
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.data ?? {});
    else pending.reject(new PcAgentError(message.error ?? 'desktop agent error', message.code ?? 'ERROR'));
  }

  #onExit(code, signal) {
    const detail = this.#stderr.trim().split('\n').slice(-4).join(' | ');
    const error = new PcAgentError(
      `desktop agent exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${detail ? `: ${detail}` : ''}`,
    );
    this.#rejectAll(error);
    this.#onReadyFailed?.(error);
    this.#child = null;
    this.#ready = null;
  }

  #rejectAll(error) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  /**
   * Send one command and resolve with its `data` payload.
   * @param {string} cmd - agent command name
   * @param {object} [args] - JSON-serializable arguments
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<object>} the command's data object
   */
  async call(cmd, args = {}, options = {}) {
    await this.start();
    const child = this.#child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new PcAgentError('desktop agent is not running');
    }
    const id = ++this.#seq;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const { signal } = options;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PcAgentError(`desktop agent timed out after ${timeoutMs}ms on "${cmd}"`));
      }, timeoutMs);

      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        // Stop whatever the agent is doing; the request itself may still finish.
        this.call('panic').catch(() => {});
        reject(new PcAgentError('desktop action aborted by the caller'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (data) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(data);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer,
      });

      const payload = JSON.stringify({ id, cmd, args });
      child.stdin.write(`${payload}\n`, 'utf8', (error) => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new PcAgentError(`failed to write to the desktop agent: ${error.message}`));
      });
    });
  }

  /** Stop the whole agent (used on plugin unload). */
  async dispose() {
    this.#disposed = true;
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    if (!child) return;
    this.#rejectAll(new PcAgentError('desktop agent disposed'));
    try { child.stdin.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve();
      }, 800);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
