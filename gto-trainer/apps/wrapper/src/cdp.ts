/**
 * The Chrome DevTools Protocol, as the wrapper uses it — port of aof-model/scout/cdp.py plus the per-module
 * variants (formats._ev, auth._cmds, launch._cdp_seq). One short-lived socket per call, like the Python: the
 * page may reload or navigate between any two calls, and a fresh connection is what makes that a non-event.
 *
 *  - 127.0.0.1, NOT localhost: on Windows localhost resolves to ::1 first and the browser only listens on IPv4,
 *    costing a 2 s timeout on EVERY call.
 *  - A CLOSED port costs the same 2 s to refuse, so `listening()` asks the OS's listening table first.
 *  - Never Runtime.enable: with nested iframes it floods the socket with executionContextCreated events and buries
 *    the evaluate response.
 */
import { js } from "./js";
import { tcpListeners } from "./win32";

export type Target = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };

/** Is anything accepting on 127.0.0.1:port — from the OS's listening table (no connect, ~ms either way). */
export function listening(port: number): boolean {
  try {
    return tcpListeners().some((l) => l.port === Number(port));
  } catch {
    return true;
  }
}

/** Which of `ports` are listening (one table read for all of them). */
export function listeningSet(ports: number[]): Set<number> {
  try {
    const live = new Set(tcpListeners().map((l) => l.port));
    return new Set(ports.filter((p) => live.has(p)));
  } catch {
    return new Set(ports);
  }
}

async function fetchJson(url: string, timeoutS: number): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function httpJson(path: string, port: number): Promise<any> {
  if (!listening(port)) throw new Error(`nothing listening on 127.0.0.1:${port}`);
  return fetchJson(`http://127.0.0.1:${port}${path}`, 2);
}

async function real_available(port: number): Promise<boolean> {
  if (!listening(port)) return false;
  try {
    await httpJson("/json/version", port);
    return true;
  } catch {
    return false;
  }
}

/** All page targets on `port` (the lobby + each table window). */
async function real_pageTargets(port: number): Promise<Target[]> {
  let targets: Target[];
  try {
    targets = await httpJson("/json", port);
  } catch {
    return [];
  }
  return (targets || []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

/** ws URLs of all frames that can run JS (page + iframes). */
async function real_allTargetWss(port: number): Promise<string[]> {
  let targets: Target[];
  try {
    targets = await httpJson("/json", port);
  } catch {
    return [];
  }
  return (targets || []).filter((t) => (t.type === "page" || t.type === "iframe") && t.webSocketDebuggerUrl)
    .map((t) => t.webSocketDebuggerUrl!);
}

/** The BROWSER-level socket of a port (Browser.* commands), or null. */
async function real_browserWs(port: number): Promise<string | null> {
  if (!listening(port)) return null;
  try {
    return (await fetchJson(`http://127.0.0.1:${port}/json/version`, 2)).webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

export class CdpError extends Error {}

/** One DevTools socket: connect, send commands, wait for their replies. */
export class CdpSocket {
  private ws!: WebSocket;
  private waiters = new Map<number, (m: any) => void>();
  private closed = false;
  private seen = 0;

  static async open(url: string, timeoutS: number): Promise<CdpSocket> {
    const s = new CdpSocket();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        try { s.ws?.close(); } catch {}
        reject(new CdpError(`timed out connecting to ${url}`));
      }, timeoutS * 1000);
      try {
        s.ws = new WebSocket(url);
      } catch (e) {
        clearTimeout(t);
        reject(e);
        return;
      }
      s.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      s.ws.onerror = () => {
        clearTimeout(t);
        reject(new CdpError(`could not connect to ${url}`));
      };
      s.ws.onclose = () => {
        s.closed = true;
        for (const w of s.waiters.values()) w({ __closed__: true });
        s.waiters.clear();
      };
      s.ws.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
        } catch {
          return;
        }
        s.seen++;
        if (typeof m.id === "number" && s.waiters.has(m.id)) {
          const w = s.waiters.get(m.id)!;
          s.waiters.delete(m.id);
          w(m);
        }
      };
    });
    return s;
  }

  send(id: number, method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) throw new CdpError("socket closed");
    this.ws.send(JSON.stringify({ id, method, params }));
  }

  /** The reply to `id`, or null after `timeoutS` / when the socket closes / after `maxMessages` other messages. */
  wait(id: number, timeoutS: number, maxMessages = Infinity): Promise<any> {
    return new Promise((resolve, reject) => {
      const start = this.seen;
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new CdpError(`timed out waiting for reply ${id}`));
      }, timeoutS * 1000);
      const check = setInterval(() => {
        if (this.seen - start > maxMessages) {
          clearTimeout(t);
          clearInterval(check);
          this.waiters.delete(id);
          resolve(null);
        }
      }, 50);
      this.waiters.set(id, (m) => {
        clearTimeout(t);
        clearInterval(check);
        if (m && m.__closed__) reject(new CdpError("socket closed before the reply"));
        else resolve(m);
      });
    });
  }

  async call(id: number, method: string, params: Record<string, unknown>, timeoutS: number): Promise<any> {
    this.send(id, method, params);
    return this.wait(id, timeoutS);
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}

/** Runtime.evaluate(returnByValue) — the page's value, or null (an exception in the page is swallowed as null,
 *  as scout's _eval does). Throws on a socket that cannot be reached or a reply that never comes. */
async function real_evaluate(wsUrl: string, expr: string, timeoutS = 4): Promise<any> {
  const s = await CdpSocket.open(wsUrl, timeoutS);
  try {
    s.send(7, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
    const m = await s.wait(7, timeoutS, 50);
    if (!m) return null;
    const v = ((m.result || {}).result || {}).value;
    return v === undefined ? null : v;
  } finally {
    s.close();
  }
}

/** formats._ev: like evaluate(), but an exception in the page is RAISED (first line of its description). */
async function real_evaluateStrict(wsUrl: string, expr: string, timeoutS = 6): Promise<any> {
  const s = await CdpSocket.open(wsUrl, timeoutS);
  try {
    s.send(7, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
    const m = await s.wait(7, timeoutS, 50);
    if (!m) return null;
    const res = m.result || {};
    const exc = res.exceptionDetails;
    if (exc) {
      const txt = (exc.exception || {}).description || exc.text || "JS exception";
      throw new CdpError(String(txt).split(/\r?\n/)[0]!.slice(0, 300));
    }
    const v = (res.result || {}).value;
    return v === undefined ? null : v;
  } finally {
    s.close();
  }
}

/** Run CDP commands in order on one socket; returns their `result`s (auth._cmds / launch._cdp_seq). */
async function real_commands(wsUrl: string, cmds: [string, Record<string, unknown>][], timeoutS = 6): Promise<any[]> {
  const s = await CdpSocket.open(wsUrl, timeoutS);
  const out: any[] = [];
  try {
    for (let i = 0; i < cmds.length; i++) {
      const [method, params] = cmds[i]!;
      const m = await s.call(i + 1, method, params, timeoutS);
      out.push(m ? m.result : null);
    }
  } finally {
    s.close();
  }
  return out;
}

/** A REAL mouse click (mouseMoved, mousePressed, mouseReleased) — React ignores a synthetic .click(). */
async function real_dispatchClick(wsUrl: string, x: number, y: number): Promise<void> {
  const base = { x, y, button: "left", clickCount: 1 };
  await io.commands(wsUrl, [
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x, y }],
    ["Input.dispatchMouseEvent", { type: "mousePressed", ...base }],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", ...base }],
  ], 5);
}

/** Page.captureScreenshot -> the image bytes, or null. */
async function real_screenshot(wsUrl: string, params: Record<string, unknown> = { format: "png" }, timeoutS = 5): Promise<Uint8Array | null> {
  const s = await CdpSocket.open(wsUrl, timeoutS);
  try {
    s.send(1, "Page.captureScreenshot", params);
    const m = await s.wait(1, timeoutS, 30);
    const data = m?.result?.data;
    return data ? new Uint8Array(Buffer.from(data, "base64")) : null;
  } finally {
    s.close();
  }
}

/** DOM text-node extractor evaluated inside each CoinPoker page (scout's reader; unused by the wrapper itself). */
export const EXTRACT_JS = () => js("cdp.EXTRACT_JS");

/**
 * THE SEAM. Every caller goes through `io`, so a test can replace the browser with a recording — the trace
 * goldens (test/golden/trace.test.ts) script the page's replies exactly as the Python recorder did and check that
 * the port asks the page the same questions in the same order.
 */
export const io = {
  available: real_available,
  pageTargets: real_pageTargets,
  allTargetWss: real_allTargetWss,
  browserWs: real_browserWs,
  evaluate: real_evaluate,
  evaluateStrict: real_evaluateStrict,
  commands: real_commands,
  dispatchClick: real_dispatchClick,
  screenshot: real_screenshot,
};
export const REAL_IO = { ...io };

export const available = (port: number) => io.available(port);
export const pageTargets = (port: number) => io.pageTargets(port);
export const allTargetWss = (port: number) => io.allTargetWss(port);
export const browserWs = (port: number) => io.browserWs(port);
export const evaluate = (wsUrl: string, expr: string, timeoutS = 4) => io.evaluate(wsUrl, expr, timeoutS);
export const evaluateStrict = (wsUrl: string, expr: string, timeoutS = 6) => io.evaluateStrict(wsUrl, expr, timeoutS);
export const commands = (wsUrl: string, cmds: [string, Record<string, unknown>][], timeoutS = 6) => io.commands(wsUrl, cmds, timeoutS);
export const dispatchClick = (wsUrl: string, x: number, y: number) => io.dispatchClick(wsUrl, x, y);
export const screenshot = (wsUrl: string, params: Record<string, unknown> = { format: "png" }, timeoutS = 5) => io.screenshot(wsUrl, params, timeoutS);
