/**
 * OCR for the CoinPoker presses — what Python's winocr gave: Windows' own OCR engine (Windows.Media.Ocr), which
 * Bun cannot call directly (it is WinRT). A PowerShell helper (win32/ocr.ps1) holds the engine and answers one image
 * per line; it is started once and kept, so a press pays for the recognition only.
 *
 * The image pipeline is cp_actions.ocr's: crop the button's box (scaled from the 1600x1170 reference layout), PIL's
 * "L" grayscale, ImageOps.autocontrast, a 2x bicubic resize, then RGBA8 (gray in every channel) the way winocr hands
 * a PIL image to the engine.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Capture } from "./win32";

let proc: ChildProcess | null = null;
let ready: Promise<void> | null = null;
let buf = "";
const waiters: ((line: string) => void)[] = [];
let chain: Promise<unknown> = Promise.resolve();

function start(): Promise<void> {
  if (ready && proc && proc.exitCode === null) return ready;
  buf = "";
  proc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "win32", "ocr.ps1")],
               { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
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

function ask(line: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      resolve('{"error":"OCR timed out"}');
    }, timeoutMs);
    const done = (l: string) => {
      clearTimeout(t);
      resolve(l);
    };
    waiters.push(done);
    proc!.stdin!.write(line + "\n");
  });
}

/** Recognise an 8-bit gray image; the lines' text, or throws. One recognition at a time. */
export function recognizeGray(gray: Uint8Array, width: number, height: number): Promise<string[]> {
  const run = async () => {
    await start();
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const g = gray[i]!;
      rgba[4 * i] = g;
      rgba[4 * i + 1] = g;
      rgba[4 * i + 2] = g;
      rgba[4 * i + 3] = 255;
    }
    const reply = await ask(`${width} ${height} ${Buffer.from(rgba).toString("base64")}`, 10000);
    let j: any;
    try {
      j = JSON.parse(reply);
    } catch {
      throw new Error(`the OCR helper answered ${JSON.stringify(reply.slice(0, 200))}`);
    }
    if (j.error) throw new Error(j.error);
    return (j.lines || []).map(String);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// ---- PIL's pixel operations ----

/** Image.crop((x0, y0, x1, y1)) of an RGB capture, then .convert("L") (ITU-R 601-2, PIL's integer form). */
export function cropGray(img: Capture, x0: number, y0: number, x1: number, y1: number): { gray: Uint8Array; w: number; h: number } {
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;     // PIL pads outside with black
      const o = (sy * img.width + sx) * 3;
      gray[y * w + x] = (img.rgb[o]! * 19595 + img.rgb[o + 1]! * 38470 + img.rgb[o + 2]! * 7471 + 0x8000) >> 16;
    }
  }
  return { gray, w, h };
}

/** ImageOps.autocontrast(image) with cutoff 0: stretch the darkest..lightest level used to 0..255. */
export function autocontrast(gray: Uint8Array): Uint8Array {
  let lo = 255, hi = 0;
  for (const v of gray) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi <= lo) return gray.slice();
  const scale = 255.0 / (hi - lo);
  const offset = -lo * scale;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const v = Math.trunc(i * scale + offset);
    lut[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return gray.map((v) => lut[v]!);
}

function cubic(x: number): number {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

/** image.resize((w * 2, h * 2)) — PIL's default resample, bicubic. */
export function resize2x(gray: Uint8Array, w: number, h: number): { gray: Uint8Array; w: number; h: number } {
  const W2 = w * 2, H2 = h * 2;
  const out = new Uint8Array(W2 * H2);
  if (!w || !h) return { gray: out, w: W2, h: H2 };
  for (let y = 0; y < H2; y++) {
    const sy = (y + 0.5) / 2 - 0.5;
    const y0 = Math.floor(sy);
    for (let x = 0; x < W2; x++) {
      const sx = (x + 0.5) / 2 - 0.5;
      const x0 = Math.floor(sx);
      let acc = 0, wsum = 0;
      for (let j = -1; j <= 2; j++) {
        const yy = Math.min(h - 1, Math.max(0, y0 + j));
        const wy = cubic(sy - (y0 + j));
        for (let i = -1; i <= 2; i++) {
          const xx = Math.min(w - 1, Math.max(0, x0 + i));
          const wgt = wy * cubic(sx - (x0 + i));
          acc += gray[yy * w + xx]! * wgt;
          wsum += wgt;
        }
      }
      const v = Math.round(acc / wsum);
      out[y * W2 + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { gray: out, w: W2, h: H2 };
}

export function stop(): void {
  try { proc?.kill(); } catch {}
  proc = null;
  ready = null;
}
