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

const { i32, u32, i64, u64, ptr: P, u16, void: V } = FFIType;

type Lib<T> = { symbols: T; close(): void };
function lazy<T>(fn: () => Lib<T>): () => T {
  let lib: Lib<T> | null = null;
  return () => (lib ??= fn()).symbols;
}

const user32 = lazy(() => dlopen("user32.dll", {
  EnumWindows: { args: [P, i64], returns: i32 },
  GetWindowTextLengthW: { args: [P], returns: i32 },
  GetWindowTextW: { args: [P, P, i32], returns: i32 },
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
  SystemParametersInfoW: { args: [u32, u32, P, u32], returns: i32 },
  SetProcessDpiAwarenessContext: { args: [i64], returns: i32 },
  SetThreadDpiAwarenessContext: { args: [i64], returns: i64 },
  GetDC: { args: [P], returns: P },
  ReleaseDC: { args: [P, P], returns: i32 },
  PrintWindow: { args: [P, P, u32], returns: i32 },
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

/** Per-thread awareness (cp_actions sets it for its own calls). */
export function setThreadDpiAware(): void {
  try {
    user32().SetThreadDpiAwarenessContext(-4n);
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

export const isWindowVisible = (h: number) => !!user32().IsWindowVisible(hwnd(h));
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

/** Usable desktop size of the primary monitor (SPI_GETWORKAREA). */
export function workArea(): [number, number] {
  const r = new Int32Array(4);
  user32().SystemParametersInfoW(0x30, 0, ptr(r), 0);
  return [r[2]! - r[0]!, r[3]! - r[1]!];
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

export function currentPid(): number {
  return process.pid;
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

export const _u64 = u64;
export const _u16 = u16;
