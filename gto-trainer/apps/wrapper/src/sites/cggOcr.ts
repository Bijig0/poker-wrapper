/**
 * OCR with line boxes for the ClubGG screen reader: Windows' own engine (Windows.Media.Ocr) through a long-lived
 * PowerShell helper (win32/screenocr.ps1), the way ocr.ts holds one for the CoinPoker presses. The frame goes over as
 * a raw BGRA file in the temp folder (one 8 MB write beats 11 MB of base64 on a pipe); the answer is every line with
 * its word boxes, in the frame's own pixels.
 *
 * The same helper decodes a recorded frame (jpg/png) back to BGRA for the replay tool — Bun has no image decoder.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OcrWord = { x: number; y: number; w: number; h: number; text: string };
export type OcrLine = { text: string; x: number; y: number; w: number; h: number; words: OcrWord[] };
export type Bgra = { width: number; height: number; bgra: Uint8Array };

let proc: ChildProcess | null = null;
let ready: Promise<void> | null = null;
let buf = "";
const waiters: ((line: string) => void)[] = [];
let chain: Promise<unknown> = Promise.resolve();
const RAW = join(tmpdir(), `pw-cgg-${process.pid}.bgra`);

function start(): Promise<void> {
  if (ready && proc && proc.exitCode === null) return ready;
  buf = "";
  proc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "..", "win32", "screenocr.ps1")],
               { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      waiters.shift()?.(line);
    }
  });
  proc.on("exit", () => {
    for (const w of waiters.splice(0)) w('{"error":"the OCR helper exited"}');
    proc = null;
    ready = null;
  });
  ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the OCR helper did not start within 20 s")), 20000);
    waiters.push((line) => {
      clearTimeout(t);
      if (line.includes('"ready":true')) resolve();
      else reject(new Error(`the OCR helper could not create an English OCR engine (${line})`));
    });
  });
  return ready;
}

function ask(req: Record<string, unknown>, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error("OCR timed out"));
    }, timeoutMs);
    const done = (l: string) => {
      clearTimeout(t);
      let j: any;
      try {
        j = JSON.parse(l);
      } catch {
        return reject(new Error(`the OCR helper answered ${JSON.stringify(l.slice(0, 200))}`));
      }
      if (j && j.error) reject(new Error(j.error));
      else resolve(j);
    };
    waiters.push(done);
    proc!.stdin!.write(JSON.stringify(req) + "\n");
  });
}

/** One request at a time (the helper answers in order; the raw file is shared). */
function serial<T>(run: () => Promise<T>): Promise<T> {
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** A helper reply's lines as OcrLine (the line box = the union of its words). */
export function linesOf(reply: any): OcrLine[] {
  const out: OcrLine[] = [];
  for (const l of reply?.lines || []) {
    const words: OcrWord[] = (l.words || []).map((w: any) => ({ x: +w[0], y: +w[1], w: +w[2], h: +w[3], text: String(w[4] ?? "") }));
    if (!words.length) continue;
    const x0 = Math.min(...words.map((w) => w.x)), y0 = Math.min(...words.map((w) => w.y));
    const x1 = Math.max(...words.map((w) => w.x + w.w)), y1 = Math.max(...words.map((w) => w.y + w.h));
    out.push({ text: String(l.text ?? ""), x: x0, y: y0, w: x1 - x0, h: y1 - y0, words });
  }
  return out;
}

/** Every text line in a BGRA frame, with boxes in the frame's pixels. */
export function recognize(frame: Bgra, timeoutMs = 8000): Promise<{ lines: OcrLine[]; ms: number }> {
  return serial(async () => {
    await start();
    writeFileSync(RAW, frame.bgra);
    const j = await ask({ op: "ocr", raw: RAW, w: frame.width, h: frame.height }, timeoutMs);
    return { lines: linesOf(j), ms: Number(j.ms ?? 0) };
  });
}

/** A recorded frame (jpg/png/bmp) as BGRA. */
export function decodeImage(path: string): Promise<Bgra> {
  return serial(async () => {
    await start();
    const out = RAW + ".dec";
    const j = await ask({ op: "decode", path, out }, 20000);
    const bgra = new Uint8Array(readFileSync(out));
    try { rmSync(out); } catch {}
    return { width: j.w, height: j.h, bgra };
  });
}

export function stop(): void {
  try { proc?.kill(); } catch {}
  proc = null;
  ready = null;
  try { rmSync(RAW); } catch {}
}
