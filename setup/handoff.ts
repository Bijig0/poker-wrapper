/**
 * Hand the installer to another machine — the OWNER's side. Two download links that expire (the channel's installer and
 * the download key, presigned by rclone), pasted into a message; nothing to attach, nothing to carry.
 *
 *   bun setup/handoff.ts                      the channel's latest published release
 *   bun setup/handoff.ts --version <v>        a staged (or older) release
 *   bun setup/handoff.ts --days 3             link lifetime (default 7, the most R2 allows)
 *   bun setup/handoff.ts --public             ALSO copy the files to C:\Users\Public\PokerWrapper — for a second Windows
 *                                             account on this computer (this one may stay signed in: the install takes
 *                                             its own ports, PORT_OFFSET) — with the release's data zips, so that
 *                                             install downloads nothing (the same folder on a USB stick is an offline
 *                                             install anywhere)
 *
 * The key link is the same read-write key every install carries (portable-setup notes): it lives on the channel only under
 * handoff/, presigned, and the link dies with --days. GTO Wizard runs in the Chrome window setup opens (there is no desktop app
 * to hand over). The message is also written to ~/poker-package/handoff-<v>.txt.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHANNEL = process.env.PW_CHANNEL || "r2:poker-solve-db/wrapper";
const PKG = join(homedir(), "poker-package");
const KEY = join(PKG, "PokerWrapper-key.txt");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const days = Number(arg("--days") ?? 7);
const toPublic = process.argv.includes("--public");

function rc(args: string[]): string {
  const r = spawnSync("rclone", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) { console.error(`rclone ${args.join(" ")} failed: ${(r.stderr || "").trim().slice(-300)}`); process.exit(1); }
  return r.stdout.trim();
}

if (!existsSync(KEY)) { console.error(`no key file at ${KEY} (portable-setup: written from the owner's rclone.conf [r2])`); process.exit(2); }

// 1. which release, and its installer's name on the channel
const version = arg("--version") ?? (JSON.parse(rc(["cat", `${CHANNEL}/latest.json`])).version as string);
const rel = JSON.parse(rc(["cat", `${CHANNEL}/releases/${version}/release.json`]));
if (!rel.installer?.file) { console.error(`release ${version} has no installer on the channel (build with --installer, then --stage or --publish)`); process.exit(3); }
const exeRemote = `${CHANNEL}/releases/${version}/${rel.installer.file}`;

// 2. the key beside it, then the links
rc(["copyto", KEY, `${CHANNEL}/handoff/PokerWrapper-key.txt`]);
const expire = `${days * 24}h`;
const exeLink = rc(["link", exeRemote, "--expire", expire]);
const keyLink = rc(["link", `${CHANNEL}/handoff/PokerWrapper-key.txt`, "--expire", expire]);
const until = new Date(Date.now() + days * 86_400_000).toLocaleDateString();

const msg = `Poker Wrapper ${version} — install it in three steps (links work until ${until}):

1. Download both into the same folder (Downloads is fine):
   the installer (${(rel.installer.bytes / 1e6).toFixed(0)} MB): ${exeLink}
   the key (save it as PokerWrapper-key.txt): ${keyLink}
2. Run PokerWrapperSetup. If Windows says "protected your PC": More info → Run anyway. The key page fills itself in.
3. Sign in to GTO Wizard in the Chrome window that opens, and leave it open. Then open Poker Wrapper from the desktop.

It downloads about 3 GB of chart data, so give it ten minutes. Setup guide: setup/INSTALL.md in the repo.`;

const out = join(PKG, `handoff-${version}.txt`);
writeFileSync(out, msg + "\n");
console.log(msg);
console.log(`\n(saved to ${out})`);

// 3. --public: the same two files where every account on this computer can read them
if (toPublic) {
  const local = join(PKG, rel.installer.file);
  if (!existsSync(local)) rc(["copyto", exeRemote, local]);
  const dir = "C:\\Users\\Public\\PokerWrapper";
  mkdirSync(dir, { recursive: true });
  copyFileSync(local, join(dir, rel.installer.file));
  copyFileSync(KEY, join(dir, "PokerWrapper-key.txt"));
  // the release's data zips too: the installer unpacks what lies beside it instead of downloading 3 GB (setup.ps1 -DataDir).
  // Every part of the release (a USB-stick kit serves any strategy); from ~/poker-package when the build left them there
  const zips: string[] = [];
  for (const [part, d] of Object.entries((rel.data ?? {}) as Record<string, { file: string; bytes: number }>)) {
    const dst = join(dir, d.file);
    if (!existsSync(dst) || statSync(dst).size !== d.bytes) {
      const local = join(PKG, d.file);
      if (existsSync(local) && statSync(local).size === d.bytes) copyFileSync(local, dst);
      else { console.log(`fetching ${d.file} (${(d.bytes / 1e6).toFixed(0)} MB) from the channel ...`); rc(["copyto", `${CHANNEL}/data/${d.file}`, dst]); }
    }
    zips.push(`${part} (${(d.bytes / 1e6).toFixed(0)} MB)`);
  }
  writeFileSync(join(dir, "README.txt"), `Poker Wrapper ${version}: sign in to the other Windows account (the owner's can stay signed in: when its Poker Wrapper holds the default ports, this install takes its own — PORT_OFFSET in config\\local.env, e.g. 50 = dashboard http://localhost:2050; the setup window says which) and run ${rel.installer.file} from this folder. The key next to it is picked up by itself; the data zips next to it are unpacked instead of downloaded (${zips.join(", ")}).${gtowName ? ` ${gtowName} is the GTO Wizard desktop app (optional; install it first if you want it).` : ""}\n`);
  console.log(`\ncopied to ${dir} for another Windows account on this computer (installer, key, data zips)`);
}
