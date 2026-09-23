/**
 * Is the connection good enough to get GTO Wizard answers in time? Port of netcheck.py.
 *
 * An answer is a CHAIN of 10-30 requests to api.gtowizard.com (Cloudflare's Sydney edge from here), so what is
 * measured is exactly that path:
 *   rtt  - TCP connect time to api.gtowizard.com:443 (one round trip to the edge)
 *   loss - connects that did not complete in 1.5 s (a lost SYN)
 *   warm - HTTPS requests on ONE kept-alive connection, like the chain makes them
 * Thresholds (see THRESHOLDS) sit between the bad link of session_20260922_194118 (rtt 290-300 ms, 3-6 of 10
 * lost, warm median 600 ms, spikes to 2.3 s -> 25 s answers) and a healthy one (rtt ~100-150 ms, warm ~400 ms).
 */
import { lookup } from "node:dns/promises";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { time } from "./clock";
import { pyRound } from "./py";

export const HOST = "api.gtowizard.com";
export const THRESHOLDS = { rttMs: 200, lostOf10: 1, warmMedMs: 800, warmMaxMs: 2000 };
export const CONNECT_TIMEOUT_S = 1.5;
export const N_CONNECT = 10;
export const N_WARM = 5;

const perf = () => performance.now();

async function realConnects(): Promise<[number[], number]> {
  let addr: string;
  try {
    addr = (await lookup(HOST, { family: 4 })).address;
  } catch {
    return [[], N_CONNECT];
  }
  const ok: number[] = [];
  let lost = 0;
  for (let i = 0; i < N_CONNECT; i++) {
    const t = perf();
    const done = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: addr, port: 443 });
      const timer = setTimeout(() => { s.destroy(); resolve(false); }, CONNECT_TIMEOUT_S * 1000);
      s.once("connect", () => { clearTimeout(timer); s.destroy(); resolve(true); });
      s.once("error", () => { clearTimeout(timer); s.destroy(); resolve(false); });
    });
    if (done) ok.push(perf() - t);
    else lost++;
  }
  return [ok, lost];
}

/** One HTTP/1.1 GET on an open TLS socket; resolves when the whole response has been read. */
function getOnce(sock: TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let headerEnd = -1;
    let need: number | null = null;
    let chunked = false;
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out")); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onErr);
      sock.off("end", onEnd);
    };
    const finish = () => { cleanup(); resolve(); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onEnd = () => { if (headerEnd >= 0) finish(); else { cleanup(); reject(new Error("connection closed")); } };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (headerEnd < 0) {
        headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const head = buf.subarray(0, headerEnd).toString("latin1");
        const cl = /\r\ncontent-length:\s*(\d+)/i.exec(head);
        chunked = /\r\ntransfer-encoding:\s*chunked/i.test(head);
        need = cl ? Number(cl[1]) : null;
      }
      const body = buf.subarray(headerEnd + 4);
      if (need !== null && body.length >= need) finish();
      else if (chunked && body.includes("\r\n0\r\n\r\n") || (chunked && body.subarray(0, 5).toString() === "0\r\n\r\n")) finish();
    };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
    sock.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nConnection: keep-alive\r\nAccept-Encoding: identity\r\n\r\n`);
  });
}

async function realWarm(): Promise<[number[], string | null]> {
  const out: number[] = [];
  let sock: TLSSocket;
  try {
    sock = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ host: HOST, port: 443, servername: HOST });
      const timer = setTimeout(() => { s.destroy(); reject(new Error("timed out")); }, 5000);
      s.once("secureConnect", () => { clearTimeout(timer); resolve(s); });
      s.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
  } catch (e: any) {
    return [out, `could not open HTTPS to ${HOST}: ${e?.message || e}`];
  }
  try {
    for (let i = 0; i < N_WARM; i++) {
      const t = perf();
      try {
        await getOnce(sock, 5000);
      } catch (e: any) {
        return [out, `request failed: ${e?.message || e}`];
      }
      out.push(perf() - t);
    }
  } finally {
    sock.destroy();
  }
  return [out, null];
}

/** Swappable for tests (the goldens script the measurements). */
export const deps = { connects: realConnects, warm: realWarm };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** One measurement + a verdict. Never throws. */
export async function probe(): Promise<Record<string, any>> {
  const t0 = time();
  const [conn, lost] = await deps.connects();
  const [warm, err] = await deps.warm();
  const rtt = conn.length ? pyRound(median(conn)) : null;
  const wmed = warm.length ? pyRound(median(warm)) : null;
  const wmax = warm.length ? pyRound(Math.max(...warm)) : null;
  const lost10 = pyRound((lost * 10) / N_CONNECT);
  const why: string[] = [];
  if (rtt === null) why.push(`could not reach ${HOST} at all`);
  else if (rtt > THRESHOLDS.rttMs) why.push(`round trip ${rtt} ms (max ${THRESHOLDS.rttMs})`);
  if (lost10 > THRESHOLDS.lostOf10) why.push(`${lost10} of 10 packets lost (max ${THRESHOLDS.lostOf10})`);
  if (err) why.push(err);
  else if (wmed !== null && wmed > THRESHOLDS.warmMedMs) why.push(`GTO Wizard requests ${wmed} ms (max ${THRESHOLDS.warmMedMs})`);
  if (wmax !== null && wmax > THRESHOLDS.warmMaxMs) why.push(`a request stalled ${wmax} ms (max ${THRESHOLDS.warmMaxMs})`);
  const ok = !why.length;
  const s = (v: number | null) => (v === null ? "None" : String(v));
  const detail = rtt !== null
    ? `round trip ${s(rtt)} ms · ${lost10}/10 lost · GTO Wizard request ${s(wmed)} ms (worst ${s(wmax)})`
    : `${HOST} unreachable`;
  return { ok, at: t0, tookS: pyRound(time() - t0, 1), rttMs: rtt, lostOf10: lost10, warmMedMs: wmed, warmMaxMs: wmax, why,
           detail: ok ? detail : "TOO SLOW for answers: " + why.join("; ") };
}

const cache: { at: number; res: Record<string, any> | null } = { at: 0.0, res: null };

/** probe(), memoised: the setup page polls preflight every few seconds and a probe is traffic itself. */
export async function cached(maxAgeS = 20.0): Promise<Record<string, any>> {
  if (cache.res === null || time() - cache.at > maxAgeS) {
    cache.res = await probe();
    cache.at = time();
  }
  return cache.res;
}
