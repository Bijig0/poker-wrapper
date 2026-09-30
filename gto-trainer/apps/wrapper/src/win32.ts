/**
 * The Windows API the wrapper uses, through bun:ffi — what Python reached with ctypes, psutil, keyring and PIL's
 * grab. Everything is loaded lazily, so importing this module costs nothing until a call needs it.
 *
 * Coordinates are PHYSICAL pixels: setDpiAware() puts the process in per-monitor-v2 awareness before the first
 * window call, exactly as launch.py did at import ("the Zenbook panel runs at 200%, an external monitor at 100%,
 * and a DPI-virtualised MoveWindow aimed at the strip lands on top of the table instead").
 *
 * Structs are laid out by hand for x64 (the only target): offsets are noted where they are not obvious.
 */
import { dlopen, FFIType, JSCallback, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { spawn as nodeSpawn } from "node:child_process";

const { i32, u32, i64, u64, ptr: P, void: V } = FFIType;

type Lib<T> = { symbols: T; close(): void };
function lazy<T>(fn: () => Lib<T>): () => T {
  let lib: Lib<T> | null = null;
  return () => (lib ??= fn()).symbols;
}

const user32 = lazy(() => dlopen("user32.dll", {
  EnumWindows: { args: [P, i64], returns: i32 },
  GetWindowTextLengthW: { args: [P], returns: i32 },
  GetWindowTextW: { args: [P, P, i32], returns: i32 },
  GetClassNameW: { args: [P, P, i32], returns: i32 },
  IsWindowVisible: { args: [P], returns: i32 },
  IsWindow: { args: [P], returns: i32 },
  IsIconic: { args: [P], returns: i32 },
  IsZoomed: { args: [P], returns: i32 },
  GetWindowThreadProcessId: { args: [P, P], returns: u32 },
  ShowWindow: { args: [P, i32], returns: i32 },
  MoveWindow: { args: [P, i32, i32, i32, i32, i32], returns: i32 },
  GetWindowRect: { args: [P, P], returns: i32 },
  GetClientRect: { args: [P, P], returns: i32 },
  ClientToScreen: { args: [P, P], returns: i32 },
  SetForegroundWindow: { args: [P], returns: i32 },
  GetForegroundWindow: { args: [], returns: P },
  GetCursorPos: { args: [P], returns: i32 },
  SetCursorPos: { args: [i32, i32], returns: i32 },
  SendInput: { args: [u32, P, i32], returns: u32 },
  WindowFromPoint: { args: [i64], returns: P },
  GetAncestor: { args: [P, u32], returns: P },
  MonitorFromPoint: { args: [i64, u32], returns: P },
  EnumDisplayMonitors: { args: [P, P, P, i64], returns: i32 },
  GetMonitorInfoW: { args: [P, P], returns: i32 },
  SetProcessDpiAwarenessContext: { args: [i64], returns: i32 },
  GetDC: { args: [P], returns: P },
  ReleaseDC: { args: [P, P], returns: i32 },
  PrintWindow: { args: [P, P, u32], returns: i32 },
  PostMessageW: { args: [P, u32, i64, i64], returns: i32 },
}));

const kernel32 = lazy(() => dlopen("kernel32.dll", {
  OpenProcess: { args: [u32, i32, u32], returns: P },
  CloseHandle: { args: [P], returns: i32 },
  QueryFullProcessImageNameW: { args: [P, u32, P, P], returns: i32 },
  CreateMutexW: { args: [P, i32, P], returns: P },
  OpenMutexW: { args: [u32, i32, P], returns: P },
  CreateToolhelp32Snapshot: { args: [u32, u32], returns: P },
  Process32FirstW: { args: [P, P], returns: i32 },
  Process32NextW: { args: [P, P], returns: i32 },
  TerminateProcess: { args: [P, u32], returns: i32 },
  WaitForSingleObject: { args: [P, u32], returns: u32 },
  GetCurrentProcessId: { args: [], returns: u32 },
  LocalFree: { args: [P], returns: P },
  CreateFileW: { args: [P, u32, u32, P, u32, u32, P], returns: i64 },
  CreateProcessW: { args: [P, P, P, P, i32, u32, P, P, P, P], returns: i32 },
  InitializeProcThreadAttributeList: { args: [P, u32, u32, P], returns: i32 },
  UpdateProcThreadAttribute: { args: [P, u32, u64, P, u64, P, P], returns: i32 },
  DeleteProcThreadAttributeList: { args: [P], returns: V },
  GetLastError: { args: [], returns: u32 },
}));

const gdi32 = lazy(() => dlopen("gdi32.dll", {
  CreateCompatibleDC: { args: [P], returns: P },
  CreateCompatibleBitmap: { args: [P, i32, i32], returns: P },
  SelectObject: { args: [P, P], returns: P },
  GetDIBits: { args: [P, P, u32, u32, P, P, u32], returns: i32 },
  DeleteObject: { args: [P], returns: i32 },
  DeleteDC: { args: [P], returns: i32 },
}));

const dwmapi = lazy(() => dlopen("dwmapi.dll", {
  DwmGetWindowAttribute: { args: [P, u32, P, u32], returns: i32 },
}));

const shcore = lazy(() => dlopen("shcore.dll", {
  GetDpiForMonitor: { args: [P, i32, P, P], returns: i32 },
  SetProcessDpiAwareness: { args: [i32], returns: i32 },
}));

const iphlpapi = lazy(() => dlopen("iphlpapi.dll", {
  GetExtendedTcpTable: { args: [P, P, i32, u32, u32, u32], returns: u32 },
}));

const advapi32 = lazy(() => dlopen("advapi32.dll", {
  CredReadW: { args: [P, u32, u32, P], returns: i32 },
  CredWriteW: { args: [P, u32], returns: i32 },
  CredDeleteW: { args: [P, u32, u32], returns: i32 },
  CredFree: { args: [P], returns: V },
}));

const ntdll = lazy(() => dlopen("ntdll.dll", {
  NtQueryInformationProcess: { args: [P, u32, P, u32, P], returns: i32 },
}));

const shell32 = lazy(() => dlopen("shell32.dll", {
  CommandLineToArgvW: { args: [P, P], returns: P },
}));

// ---------------------------------------------------------------------------------- small helpers

/** A NUL-terminated UTF-16 string for an LPCWSTR argument. */
export function wstr(s: string): Uint16Array {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

/** Read a NUL-terminated UTF-16 string at a native pointer. */
export function readWstr(p: Pointer | number | null, maxChars = 32768): string {
  if (!p) return "";
  let out = "";
  for (let i = 0; i < maxChars; i++) {
    const c = read.u16(p as Pointer, i * 2);
    if (!c) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** A POINT passed BY VALUE (x64: packed into one 64-bit register, x in the low half). */
function pointArg(x: number, y: number): bigint {
  return (BigInt.asUintN(32, BigInt(Math.trunc(y))) << 32n) | BigInt.asUintN(32, BigInt(Math.trunc(x)));
}

const hwnd = (h: number | Pointer) => h as unknown as Pointer;

// ---------------------------------------------------------------------------------- DPI

let dpiDone = false;
/** Per-monitor-v2 DPI awareness, before the first user32 call — or every placement is off by the scale. */
export function setDpiAware(): void {
  if (dpiDone) return;
  dpiDone = true;
  try {
    if (user32().SetProcessDpiAwarenessContext(-4n)) return;
  } catch {}
  try {
    shcore().SetProcessDpiAwareness(2);
  } catch {}
}

// ---------------------------------------------------------------------------------- windows

export type Rect = { left: number; top: number; right: number; bottom: number };

/** Every top-level window, in Z order (EnumWindows). */
export function enumWindows(): number[] {
  setDpiAware();
  const out: number[] = [];
  const cb = new JSCallback((h: number) => {
    out.push(Number(h));
    return 1;
  }, { args: [P, i64], returns: i32 });
  try {
    user32().EnumWindows(cb.ptr!, 0n);
  } finally {
    cb.close();
  }
  return out;
}

export function windowText(h: number): string {
  const n = user32().GetWindowTextLengthW(hwnd(h));
  if (!n) return "";
  const buf = new Uint16Array(n + 1);
  const got = user32().GetWindowTextW(hwnd(h), ptr(buf), n + 1);
  return String.fromCharCode(...buf.subarray(0, got));
}

/** GetWindowTextW into a fixed buffer (cp_actions reads at most 120 chars). */
export function windowTextN(h: number, n: number): string {
  const buf = new Uint16Array(n);
  const got = user32().GetWindowTextW(hwnd(h), ptr(buf), n);
  return String.fromCharCode(...buf.subarray(0, Math.max(0, got)));
}

/** The window's class name (GetClassNameW) — a Unity player's windows are "UnityWndClass". */
export function className(h: number): string {
  const buf = new Uint16Array(256);
  const got = user32().GetClassNameW(hwnd(h), ptr(buf), 256);
  return String.fromCharCode(...buf.subarray(0, Math.max(0, got)));
}

export const isWindowVisible = (h: number) => !!user32().IsWindowVisible(hwnd(h));
/** Ask a window to close, exactly as its X button does (WM_CLOSE, posted — the window's own code decides). */
export const closeWindow = (h: number) => !!user32().PostMessageW(hwnd(h), 0x0010, 0n, 0n);
export const isWindow = (h: number) => !!h && !!user32().IsWindow(hwnd(h));
export const isIconic = (h: number) => !!user32().IsIconic(hwnd(h));
export const isZoomed = (h: number) => !!user32().IsZoomed(hwnd(h));
export const showWindow = (h: number, cmd: number) => !!user32().ShowWindow(hwnd(h), cmd);
export const moveWindow = (h: number, x: number, y: number, w: number, hh: number) =>
  !!user32().MoveWindow(hwnd(h), Math.trunc(x), Math.trunc(y), Math.trunc(w), Math.trunc(hh), 1);
export const setForegroundWindow = (h: number) => !!user32().SetForegroundWindow(hwnd(h));
export const getForegroundWindow = () => Number(user32().GetForegroundWindow() || 0);

export function windowPid(h: number): number {
  const pid = new Uint32Array(1);
  user32().GetWindowThreadProcessId(hwnd(h), ptr(pid));
  return pid[0]!;
}

export function windowRect(h: number): Rect {
  const r = new Int32Array(4);
  user32().GetWindowRect(hwnd(h), ptr(r));
  return { left: r[0]!, top: r[1]!, right: r[2]!, bottom: r[3]! };
}

/** (x, y, w, h) of the CLIENT area in screen coordinates (cp_actions.client_rect). */
export function clientRect(h: number): [number, number, number, number] {
  const r = new Int32Array(4);
  user32().GetClientRect(hwnd(h), ptr(r));
  const pt = new Int32Array(2);
  user32().ClientToScreen(hwnd(h), ptr(pt));
  return [pt[0]!, pt[1]!, r[2]!, r[3]!];
}

export function cursorPos(): [number, number] {
  const pt = new Int32Array(2);
  user32().GetCursorPos(ptr(pt));
  return [pt[0]!, pt[1]!];
}

export const setCursorPos = (x: number, y: number) => !!user32().SetCursorPos(Math.trunc(x), Math.trunc(y));

/** The top-level window under a screen point (WindowFromPoint + GetAncestor(GA_ROOT)), or 0. */
export function ownerAt(x: number, y: number): number {
  const hit = Number(user32().WindowFromPoint(pointArg(x, y)) || 0);
  return hit ? Number(user32().GetAncestor(hwnd(hit), 2) || 0) : 0;
}

/** DWM hides a window on another virtual desktop (DWMWA_CLOAKED). */
export function cloaked(h: number): boolean {
  const v = new Uint32Array(1);
  try {
    dwmapi().DwmGetWindowAttribute(hwnd(h), 14, ptr(v), 4);
  } catch {
    return false;
  }
  return v[0] !== 0;
}

/** The image path of the process owning `pid` (QueryFullProcessImageNameW), or "". */
export function processImagePath(pid: number): string {
  const hp = kernel32().OpenProcess(0x1000, 0, pid);
  if (!hp) return "";
  try {
    const size = new Uint32Array([1024]);
    const buf = new Uint16Array(1024);
    if (!kernel32().QueryFullProcessImageNameW(hp, 0, ptr(buf), ptr(size))) return "";
    return String.fromCharCode(...buf.subarray(0, size[0]!));
  } finally {
    kernel32().CloseHandle(hp);
  }
}

// ---------------------------------------------------------------------------------- monitors

export type Monitor = { x: number; y: number; w: number; h: number; primary: boolean; fw: number; fh: number };

/** Work areas of all attached monitors (primary flagged); fw/fh = the whole screen. */
export function monitors(): Monitor[] {
  setDpiAware();
  const out: Monitor[] = [];
  const cb = new JSCallback((hmon: number) => {
    const mi = new Int32Array(10);            // cbSize, rcMonitor(4), rcWork(4), dwFlags
    mi[0] = 40;
    user32().GetMonitorInfoW(hwnd(hmon), ptr(mi));
    const [, ml, mt, mr, mb, wl, wt, wr, wb, flags] = mi as unknown as number[];
    out.push({ x: wl!, y: wt!, w: wr! - wl!, h: wb! - wt!, primary: !!(flags! & 1), fw: mr! - ml!, fh: mb! - mt! });
    return 1;
  }, { args: [P, P, P, i64], returns: i32 });
  try {
    user32().EnumDisplayMonitors(null, null, cb.ptr!, 0n);
  } finally {
    cb.close();
  }
  return out;
}

/** DPI of the monitor nearest a physical point; 96 when unknown. */
export function dpiAt(x: number, y: number): number {
  try {
    const hmon = user32().MonitorFromPoint(pointArg(x, y), 2);
    const dx = new Uint32Array(1), dy = new Uint32Array(1);
    if (shcore().GetDpiForMonitor(hmon, 0, ptr(dx), ptr(dy)) === 0) return dx[0]! || 96;
  } catch {}
  return 96;
}

// ---------------------------------------------------------------------------------- real input (SendInput)

const INPUT_SIZE = 40;

export function sendMouseFlags(flags: number): void {
  const b = new Uint8Array(INPUT_SIZE);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0, true);                   // INPUT_MOUSE
  dv.setUint32(20, flags, true);              // MOUSEINPUT.dwFlags (union at +8: dx, dy, mouseData, dwFlags)
  user32().SendInput(1, ptr(b), INPUT_SIZE);
}

export function sendKey(vk: number, scan: number, flags: number): void {
  const b = new Uint8Array(INPUT_SIZE);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 1, true);                   // INPUT_KEYBOARD
  dv.setUint16(8, vk, true);                  // KEYBDINPUT.wVk
  dv.setUint16(10, scan, true);               // .wScan
  dv.setUint32(12, flags, true);              // .dwFlags
  user32().SendInput(1, ptr(b), INPUT_SIZE);
}

// ---------------------------------------------------------------------------------- capture (PrintWindow)

export type Capture = { width: number; height: number; rgb: Uint8Array };

/** The window's client area, PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT) — works while covered. RGB bytes. */
export function capture(h: number): Capture {
  const [, , w, hh] = clientRect(h);
  const hdc = user32().GetDC(hwnd(h));
  const mdc = gdi32().CreateCompatibleDC(hdc);
  const bmp = gdi32().CreateCompatibleBitmap(hdc, w, hh);
  gdi32().SelectObject(mdc, bmp);
  user32().PrintWindow(hwnd(h), mdc, 3);
  const bmi = new Int32Array(10);             // BITMAPINFOHEADER (40 bytes)
  const dv = new DataView(bmi.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, w, true);
  dv.setInt32(8, -hh, true);                  // top-down
  dv.setUint16(12, 1, true);
  dv.setUint16(14, 32, true);
  const buf = new Uint8Array(Math.max(1, w * hh * 4));
  gdi32().GetDIBits(mdc, bmp, 0, hh, ptr(buf), ptr(bmi), 0);
  gdi32().DeleteObject(bmp);
  gdi32().DeleteDC(mdc);
  user32().ReleaseDC(hwnd(h), hdc);
  const rgb = new Uint8Array(w * hh * 3);
  for (let i = 0, j = 0; i < w * hh * 4; i += 4, j += 3) {
    rgb[j] = buf[i + 2]!;
    rgb[j + 1] = buf[i + 1]!;
    rgb[j + 2] = buf[i]!;
  }
  return { width: w, height: hh, rgb };
}

/** ok = BitBlt copied it (false while the workstation is locked: there is no screen to copy — the frame is black). */
export type ScreenCapture = { width: number; height: number; bgra: Uint8Array; x: number; y: number; ok: boolean };

// GDI handles as 64-bit INTEGERS: the screen DC is a sign-extended handle (0xFFFFFFFF8A…), which a JS number
// cannot hold — through FFIType.ptr it came back rounded and every call after it failed (a black capture).
const gdiH = lazy(() => dlopen("gdi32.dll", {
  CreateCompatibleDC: { args: [u64], returns: u64 },
  CreateCompatibleBitmap: { args: [u64, i32, i32], returns: u64 },
  SelectObject: { args: [u64, u64], returns: u64 },
  BitBlt: { args: [u64, i32, i32, i32, i32, u64, i32, i32, u32], returns: i32 },
  GetDIBits: { args: [u64, u64, u32, u32, P, P, u32], returns: i32 },
  DeleteObject: { args: [u64], returns: i32 },
  DeleteDC: { args: [u64], returns: i32 },
}));
const userH = lazy(() => dlopen("user32.dll", {
  GetDC: { args: [u64], returns: u64 },
  ReleaseDC: { args: [u64, u64], returns: i32 },
}));

/** The window's client area COPIED OFF THE SCREEN (BitBlt from the desktop DC), BGRA top-down. For a window that
 *  answers PrintWindow with black (ClubGG's Unity player does): what is on screen there is what you get, so the
 *  caller must know the window is uncovered first (ownerAt over its area). */
export function captureScreen(h: number): ScreenCapture {
  setDpiAware();
  const [x, y, w, hh] = clientRect(h);
  const G = gdiH(), U = userH();
  const sdc = U.GetDC(0n);
  const mdc = G.CreateCompatibleDC(sdc);
  const bmp = G.CreateCompatibleBitmap(sdc, w, hh);
  const old = G.SelectObject(mdc, bmp);
  const ok = !!G.BitBlt(mdc, 0, 0, w, hh, sdc, x, y, 0x00CC0020);     // SRCCOPY
  G.SelectObject(mdc, old);                                           // GetDIBits wants the bitmap out of the DC
  const bmi = new Int32Array(10);
  const dv = new DataView(bmi.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, w, true);
  dv.setInt32(8, -hh, true);
  dv.setUint16(12, 1, true);
  dv.setUint16(14, 32, true);
  const bgra = new Uint8Array(Math.max(4, w * hh * 4));
  G.GetDIBits(mdc, bmp, 0, hh, ptr(bgra), ptr(bmi), 0);
  G.DeleteObject(bmp);
  G.DeleteDC(mdc);
  U.ReleaseDC(0n, sdc);
  return { width: w, height: hh, bgra, x, y, ok };
}

// ---------------------------------------------------------------------------------- mutex

/** The single-instance guard: true when a mutex of that name already existed. */
export function mutexExists(name: string): boolean {
  const h = kernel32().OpenMutexW(0x00100000, 0, ptr(wstr(name)));   // SYNCHRONIZE
  if (h) {
    kernel32().CloseHandle(h);
    return true;
  }
  return false;
}

const heldMutexes: unknown[] = [];
export function createMutex(name: string): void {
  const h = kernel32().CreateMutexW(null, 0, ptr(wstr(name)));
  if (h) heldMutexes.push(h);
}

// ---------------------------------------------------------------------------------- processes

export type Proc = { pid: number; ppid: number; name: string };

export function listProcesses(): Proc[] {
  const snap = kernel32().CreateToolhelp32Snapshot(0x2, 0);
  if (!snap || Number(snap) === -1) return [];
  const out: Proc[] = [];
  try {
    const e = new Uint8Array(568);            // PROCESSENTRY32W
    const dv = new DataView(e.buffer);
    dv.setUint32(0, 568, true);
    let ok = kernel32().Process32FirstW(snap, ptr(e));
    while (ok) {
      const pid = dv.getUint32(8, true);
      const ppid = dv.getUint32(32, true);
      let name = "";
      for (let i = 44; i < 568; i += 2) {
        const c = dv.getUint16(i, true);
        if (!c) break;
        name += String.fromCharCode(c);
      }
      out.push({ pid, ppid, name });
      ok = kernel32().Process32NextW(snap, ptr(e));
    }
  } finally {
    kernel32().CloseHandle(snap);
  }
  return out;
}

/** A process's command line, split the way Windows (and psutil) split it — CommandLineToArgvW. null when it
 *  cannot be read (another user's process, gone, or protected). */
export function processCmdline(pid: number): string[] | null {
  const hp = kernel32().OpenProcess(0x1000, 0, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
  if (!hp) return null;
  try {
    const len = new Uint32Array(1);
    ntdll().NtQueryInformationProcess(hp, 60, null, 0, ptr(len));          // ProcessCommandLineInformation
    if (!len[0]) return null;
    // OUT-OF-LINE FROM THE START: a small typed array's storage is RELOCATED the first time its .buffer is
    // touched, so a pointer taken before that goes stale — and this one is compared with a pointer the kernel
    // wrote into the buffer (measured: ptr() before and after `.buffer` differed by 30 MB)
    const buf = new Uint8Array(new ArrayBuffer(len[0] + 16));
    const base = Number(ptr(buf));
    if (ntdll().NtQueryInformationProcess(hp, 60, base as unknown as Pointer, buf.length, ptr(len)) !== 0) return null;
    const dv = new DataView(buf.buffer);
    const bytes = dv.getUint16(0, true);                                     // UNICODE_STRING.Length
    const bufPtr = Number(dv.getBigUint64(8, true));                         // .Buffer (points inside buf)
    const off = bufPtr - base;
    if (off < 0 || off + bytes > buf.length) return null;
    const cmd = new Uint16Array(bytes / 2 + 1);
    cmd.set(new Uint16Array(buf.buffer.slice(off, off + bytes)));
    return commandLineToArgv(cmd);
  } finally {
    kernel32().CloseHandle(hp);
  }
}

function commandLineToArgv(cmd: Uint16Array): string[] {
  if (!cmd[0]) return [];
  const argc = new Int32Array(1);
  const arr = shell32().CommandLineToArgvW(ptr(cmd), ptr(argc));
  if (!arr) return [];
  try {
    const out: string[] = [];
    for (let i = 0; i < argc[0]!; i++) out.push(readWstr(read.ptr(arr, i * 8) as unknown as Pointer));
    return out;
  } finally {
    kernel32().LocalFree(arr);
  }
}

/** TerminateProcess; true when the call succeeded. */
export function terminateProcess(pid: number): boolean {
  const hp = kernel32().OpenProcess(0x0001 | 0x00100000, 0, pid);   // PROCESS_TERMINATE | SYNCHRONIZE
  if (!hp) return false;
  try {
    return !!kernel32().TerminateProcess(hp, 1);
  } finally {
    kernel32().CloseHandle(hp);
  }
}

/** One argument quoted so CommandLineToArgvW (and the MSVC runtime) parse it back unchanged. */
export function quoteArg(a: string): string {
  if (a && !/[ \t\n\v"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === "\\") { bs++; continue; }
    out += ch === '"' ? "\\".repeat(bs * 2 + 1) + '"' : "\\".repeat(bs) + ch;
    bs = 0;
  }
  return out + "\\".repeat(bs * 2) + '"';
}

/**
 * Start a detached process that inherits NOTHING of ours except a NUL stdin/stdout/stderr, and return its pid.
 *
 * node:child_process spawns with bInheritHandles=TRUE, so every inheritable handle the wrapper holds goes to the
 * child — the panel port's listening socket included. The app-mode browser outlives the wrapper by design, so when
 * the wrapper died the browser kept :7700 LISTENING with nobody behind it: connections were accepted and never
 * answered (the setup page sat on "Checking…"), and a relaunch could not take the port. Reproduced with Bun 1.3.14
 * and Brave: the port stays listening after the parent is killed and frees the moment the browser closes.
 * PROC_THREAD_ATTRIBUTE_HANDLE_LIST restricts inheritance to the one NUL handle. Throws when it cannot start.
 */
export function spawnDetached(exe: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; hide?: boolean } = {}): number {
  const k = kernel32();
  const sa = new Uint8Array(24);                            // SECURITY_ATTRIBUTES { nLength, lpSD, bInheritHandle }
  const sav = new DataView(sa.buffer);
  sav.setUint32(0, 24, true);
  sav.setInt32(16, 1, true);
  // GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE, OPEN_EXISTING
  const nul = BigInt(k.CreateFileW(ptr(wstr("NUL")), 0xC0000000, 3, ptr(sa), 3, 0, null));
  if (nul === -1n || nul === 0n) throw new Error(`could not open NUL (error ${k.GetLastError()})`);
  try {
    const size = new BigUint64Array(1);
    k.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));   // sizing call: fails by design, fills `size`
    const attr = new Uint8Array(Number(size[0]) || 64);
    if (!k.InitializeProcThreadAttributeList(ptr(attr), 1, 0, ptr(size))) throw new Error(`InitializeProcThreadAttributeList failed (error ${k.GetLastError()})`);
    try {
      const handles = new BigUint64Array([nul]);
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST
      if (!k.UpdateProcThreadAttribute(ptr(attr), 0, 0x20002, ptr(handles), 8, null, null)) throw new Error(`UpdateProcThreadAttribute failed (error ${k.GetLastError()})`);
      const si = new Uint8Array(112);                       // STARTUPINFOEXW = STARTUPINFOW (104) + lpAttributeList
      const dv = new DataView(si.buffer);
      dv.setUint32(0, 112, true);
      dv.setUint32(60, 0x100 | (opts.hide ? 0x1 : 0), true);   // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
      dv.setUint16(64, 0, true);                              // wShowWindow = SW_HIDE (read only with USESHOWWINDOW)
      for (const off of [80, 88, 96]) dv.setBigUint64(off, nul, true);
      dv.setBigUint64(104, BigInt(ptr(attr)), true);
      let envBlock: Uint16Array | null = null;
      if (opts.env) {
        const entries = Object.entries(opts.env).filter(([kk, v]) => kk && !kk.includes("=") && v !== undefined)
          .sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
        envBlock = wstr(entries.map(([kk, v]) => `${kk}=${v}\0`).join("") + "\0");
      }
      const cmd = wstr([exe, ...args].map(quoteArg).join(" "));   // writable buffer, as CreateProcessW requires
      const pi = new Uint8Array(24);                          // PROCESS_INFORMATION { hProcess, hThread, pid, tid }
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS (| CREATE_UNICODE_ENVIRONMENT)
      const flags = 0x00080000 | 0x200 | 0x8 | (envBlock ? 0x400 : 0);
      const ok = k.CreateProcessW(null, ptr(cmd), null, null, 1, flags, envBlock ? ptr(envBlock) : null,
                                  opts.cwd ? ptr(wstr(opts.cwd)) : null, ptr(si), ptr(pi));
      if (!ok) throw new Error(`CreateProcessW failed for ${exe} (error ${k.GetLastError()})`);
      const pv = new DataView(pi.buffer);
      k.CloseHandle(Number(pv.getBigUint64(0, true)) as unknown as Pointer);
      k.CloseHandle(Number(pv.getBigUint64(8, true)) as unknown as Pointer);
      return pv.getUint32(16, true);
    } finally {
      k.DeleteProcThreadAttributeList(ptr(attr));
    }
  } finally {
    k.CloseHandle(Number(nul) as unknown as Pointer);
  }
}

/** spawnDetached, falling back to node:child_process (which leaks our handles) if the native path fails —
 *  a window that opens beats one that does not. `warn` hears about the fallback. */
export function startDetached(exe: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; hide?: boolean } = {},
                              warn?: (msg: string) => void): number | null {
  try {
    return spawnDetached(exe, args, opts);
  } catch (e: any) {
    warn?.(`[spawn] ${e?.message ?? e} — falling back to node:child_process (the child inherits the wrapper's handles)`);
    const child = nodeSpawn(exe, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: "ignore", windowsHide: !!opts.hide });
    child.unref();
    return child.pid ?? null;
  }
}

/**
 * Start a process OUTSIDE our process tree (WMI Win32_Process.Create: its parent is WmiPrvSE.exe), return its pid.
 *
 * Mullvad split tunneling excludes every DESCENDANT of an excluded app, and bun.exe is excluded so GTO Wizard goes
 * direct (see connection-guard). A browser we spawn ourselves therefore left from the Jakarta IP and Ignition refused
 * it ("not available from your state") while the same site in Brady's own Chrome — on the tunnel — signed in fine.
 * Measured 2026-09-24: bun child → Indonesia, WMI-created from bun → Mullvad Melbourne. Inherits none of our handles
 * either (the startDetached concern). Falls back to startDetached when WMI fails: a window that opens beats none.
 */
export function startOutsideTree(exe: string, args: string[], warn?: (msg: string) => void): number | null {
  const cmd = [exe, ...args].map(quoteArg).join(" ");
  const ps = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:WRAPPER_WMI_CMD}; "
    + "\"$($r.ReturnValue) $($r.ProcessId)\"";
  try {
    const p = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                            { env: { ...process.env, WRAPPER_WMI_CMD: cmd }, timeout: 20000, windowsHide: true } as any);
    const [rc, pid] = p.stdout.toString().trim().split(/\s+/).map(Number);
    if (rc === 0 && pid > 0) return pid;
    warn?.(`[spawn] WMI Create returned ${rc} (${p.stderr.toString().trim().slice(0, 200)}) — starting inside our tree (off the VPN)`);
  } catch (e: any) {
    warn?.(`[spawn] WMI Create failed: ${e?.message ?? e} — starting inside our tree (off the VPN)`);
  }
  return startDetached(exe, args, {}, warn);
}

/** Is the process still running? (WaitForSingleObject(h, 0) == WAIT_TIMEOUT) */
export function processAlive(pid: number): boolean {
  const hp = kernel32().OpenProcess(0x00100000 | 0x1000, 0, pid);
  if (!hp) return false;
  try {
    return kernel32().WaitForSingleObject(hp, 0) === 0x102;
  } finally {
    kernel32().CloseHandle(hp);
  }
}

/** Every ancestor of `pid` (psutil.Process(pid).parents()). */
export function ancestors(pid: number, procs: Proc[] = listProcesses()): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: number[] = [];
  let cur = byPid.get(pid);
  const seen = new Set<number>();
  while (cur && cur.ppid && !seen.has(cur.ppid)) {
    seen.add(cur.ppid);
    const parent = byPid.get(cur.ppid);
    if (!parent) break;
    out.push(parent.pid);
    cur = parent;
  }
  return out;
}

// ---------------------------------------------------------------------------------- TCP listeners

export type Listener = { port: number; pid: number };

function tcpTable(af: number, rowSize: number, stateOff: number, portOff: number, pidOff: number): Listener[] {
  try {
    const size = new Uint32Array(1);
    iphlpapi().GetExtendedTcpTable(null, ptr(size), 0, af, 3, 0);
    const buf = new Uint8Array(new ArrayBuffer(size[0]! + 4096));
    size[0] = buf.length;
    if (iphlpapi().GetExtendedTcpTable(ptr(buf), ptr(size), 0, af, 3, 0) !== 0) return [];
    const dv = new DataView(buf.buffer);
    const n = dv.getUint32(0, true);
    const out: Listener[] = [];
    for (let i = 0; i < n; i++) {
      const off = 4 + i * rowSize;
      if (dv.getUint32(off + stateOff, true) !== 2) continue;   // MIB_TCP_STATE_LISTEN
      out.push({ port: (dv.getUint8(off + portOff) << 8) | dv.getUint8(off + portOff + 1), pid: dv.getUint32(off + pidOff, true) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Every TCP socket in LISTEN, IPv4 and IPv6 (psutil.net_connections("tcp") covers both), with its owning pid
 *  (GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER). */
export function tcpListeners(): Listener[] {
  // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid (24 bytes)
  // MIB_TCP6ROW_OWNER_PID: localAddr[16], scope, localPort, remoteAddr[16], scope, remotePort, state, pid (56)
  return [...tcpTable(2, 24, 0, 8, 20), ...tcpTable(23, 56, 48, 20, 52)];
}

// ---------------------------------------------------------------------------------- Credential Manager

export type Credential = { userName: string; blob: Uint8Array };

/** CredReadW(target, CRED_TYPE_GENERIC); null when there is none. */
export function credRead(target: string): Credential | null {
  const pp = new BigUint64Array(1);
  if (!advapi32().CredReadW(ptr(wstr(target)), 1, 0, ptr(pp))) return null;
  const p = Number(pp[0]) as unknown as Pointer;
  try {
    const blobSize = read.u32(p, 32);
    const blobPtr = read.ptr(p, 40) as unknown as Pointer;
    const userPtr = read.ptr(p, 72) as unknown as Pointer;
    const blob = blobSize && blobPtr ? new Uint8Array(toArrayBuffer(blobPtr, 0, blobSize).slice(0)) : new Uint8Array(0);
    return { userName: readWstr(userPtr), blob };
  } finally {
    advapi32().CredFree(p);
  }
}

/** CredWriteW: a GENERIC credential, the blob as given, with python-keyring's comment and persistence. */
export function credWrite(target: string, userName: string, blob: Uint8Array, persist = 3): boolean {
  const cred = new Uint8Array(80);            // CREDENTIALW
  const dv = new DataView(cred.buffer);
  const t = wstr(target), c = wstr("Stored using python-keyring"), u = wstr(userName);
  dv.setUint32(4, 1, true);                   // Type = CRED_TYPE_GENERIC
  dv.setBigUint64(8, BigInt(ptr(t)), true);   // TargetName
  dv.setBigUint64(16, BigInt(ptr(c)), true);  // Comment
  dv.setUint32(32, blob.length, true);        // CredentialBlobSize
  dv.setBigUint64(40, blob.length ? BigInt(ptr(blob)) : 0n, true);
  dv.setUint32(48, persist, true);            // Persist (CRED_PERSIST_ENTERPRISE, keyring's default)
  dv.setBigUint64(72, BigInt(ptr(u)), true);  // UserName
  return !!advapi32().CredWriteW(ptr(cred), 0);
}

export function credDelete(target: string): boolean {
  return !!advapi32().CredDeleteW(ptr(wstr(target)), 1, 0);
}

/** UTF-16LE bytes, as pywin32 writes a str credential blob. */
export function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 * i] = c & 0xff;
    out[2 * i + 1] = c >> 8;
  }
  return out;
}

/** keyring's DecodingCredential.value: UTF-16 first, UTF-8 when that fails. */
export function decodeBlob(b: Uint8Array): string {
  if (b.length % 2 === 0) {
    try {
      return new TextDecoder("utf-16le", { fatal: true }).decode(b);
    } catch {}
  }
  return new TextDecoder("utf-8").decode(b);
}

