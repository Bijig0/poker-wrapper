# Poker Wrapper — installing on your laptop

The Poker Wrapper sits beside your poker table and shows a study answer for each decision. Its dashboard (in your
browser) is where you look back at your sessions and hands. It works with **Ignition** and **CoinPoker**.

The install takes about **10 minutes**, most of it a 3 GB download that setup handles by itself.

---

## What you need

- A Windows 10 or 11 laptop with **15 GB free** and an internet connection. Two monitors is best (table on one,
  answers on the other), but one works.
- From the person who gave you this: **`PokerWrapperSetup-<version>.exe`** and **`PokerWrapper-key.txt`**, your
  download key (charts, data and updates come through it). Keep the key to yourself.
- Your own **GTO Wizard** account on a plan with GTO Wizard AI (**Ultra**). The answers after the flop come from it.
  The GTO Wizard desktop app is optional: install it **before** the Poker Wrapper if you want it, and the Poker
  Wrapper uses it; otherwise it runs GTO Wizard in a Chrome window of its own.
- Your own **Ignition** and/or **CoinPoker** account.

> ⚠️ **Read this first.** Using any tool like this while playing for real money is against Ignition's and
> CoinPoker's terms, and CoinPoker actively scans for software it doesn't like. The risk to your accounts is
> yours. Never sit at the same table as the person who gave you this.

## 1. Install

1. Put `PokerWrapperSetup-<version>.exe` and `PokerWrapper-key.txt` in the same folder (Downloads is fine). If you were
   also given `PokerWrapper-data-*.zip` files (a USB stick), put them in that folder too: they are unpacked instead of
   downloaded, and the install needs no internet until the GTO Wizard sign-in.
2. Double-click **PokerWrapperSetup**.
   - If Windows says *"Windows protected your PC"*: **More info → Run anyway**. (The installer isn't signed by
     a publisher Microsoft knows. That's expected.)
3. **Download key** page: the three boxes are already filled in from `PokerWrapper-key.txt`. If they're empty,
   press **Load key file…** and choose it.
4. **What will you play?** page: pick your tables (today the one choice is **Ignition 6-max NL200**). Only the data
   for that is downloaded.
5. Press **Install**. When the files are copied, a window opens and finishes the setup: it downloads the
   chart data (about 3 GB; you'll see the progress) unless the zips lie next to the installer, installs Chrome and Brave
   if you don't have them, and starts the Poker Wrapper's background services. Leave it running. It closes by itself
   when everything is green. An older Poker Wrapper you ran from another folder (a zip install) is stopped and replaced;
   its folder is left for you to delete.
6. A **GTO Wizard window** opens during that step: the GTO Wizard app if you installed it beforehand, otherwise a
   Chrome window on app.gtowizard.com (Chrome is installed for you if the laptop has none; this Chrome window is
   separate from your normal one on purpose). **Sign in** there and leave it open (you can minimise it). It is kept
   running for you from then on, and restarted if it ever drops. Always leave it open while you play.

You now have **Poker Wrapper** and **Poker Dashboard** in the Start menu and on the desktop. That's everything.

## 2. Your poker accounts

**CoinPoker:** install it from coinpoker.com and sign in as usual. The Poker Wrapper reads the table from
CoinPoker's own log, so you sit down in CoinPoker yourself like always.

**Ignition:** the Poker Wrapper signs you in:
1. Open **Poker Wrapper**. The *Session setup* page opens.
2. Choose **Site: Ignition**, then under *Table* click **profiles…**
3. Enter a name, your Ignition e-mail and password, then **Save profile**. The password goes into Windows
   Credential Manager on your laptop and nowhere else.

## 3. Play

1. Open **Poker Wrapper**.
2. Pick the **Site**, the **Mode** (each strategy card says which tables it's built for) and the **Table**.
3. Wait for **Preflight** to go green, then **Start session**.
   - Ignition: it opens the table window and takes you to a table.
   - CoinPoker: open CoinPoker and sit down; the panel follows your table. Answers come for **heads-up NL200**
     (the "CoinPoker 200NL Heads-Up" strategy). Other CoinPoker tables are recorded but get no answers yet.
4. When it's your turn, the panel shows the answer. **End session** when you're done.

**Poker Dashboard** (or http://localhost:2000 in any browser — the setup checklist says if yours is on another port)
has every session and hand you played, with the answer for each decision.

---

## When something's wrong

1. Most "not answering" problems go away after **restarting the laptop**: everything starts by itself at logon.
2. Signed out of GTO Wizard, or closed its window? Open the install folder (`%LOCALAPPDATA%\Programs\PokerWrapper`)
   and double-click `setup\gtow-signin.cmd`.
3. Still stuck? **Run PokerWrapperSetup again.** It repairs the install and keeps your hands, settings and key.
   Its last window is a checklist: send a **screenshot** of it to the person who gave you this.

**Updates:** when a new version is out, the Poker Wrapper's setup page shows a blue **Update available** bar. End
your session and press **Update now**. Your settings, sign-ins and hand history are kept.

**Uninstall:** Windows **Settings → Apps → Poker Wrapper → Uninstall**. It asks whether to delete your hand history
too (the default is No).

---

## For the owner: making and handing out the installer

- New charts / pool / MES data from the chart factory first: in the `poker` repo,
  `bun scripts/export_to_wrapper.ts --r2-index`, then commit here what it moved (the README's "The chart factory").
- `setup\publish.cmd` (or the owner's "Friend release" bar) in this repo runs the gate, builds the release **and the
  installer**, and uploads both. The newest installer is always at `r2:poker-solve-db/wrapper/PokerWrapperSetup.exe`, and a
  local copy is in `~\poker-package\PokerWrapperSetup-<version>.exe`.
- Build one without publishing: `bun setup\buildPackage.ts --installer` (needs Inno Setup:
  `winget install JRSoftware.InnoSetup --scope user`).
- Hand it over with `setup\handoff.cmd`: it prints a message with download links (the installer, the key, and the GTO
  Wizard desktop app's installer if one is in your Downloads — valid 7 days) to paste to the person. `--public` also
  puts the installer, the key, the GTO Wizard app AND the release's data zips in `C:\Users\Public\PokerWrapper`: for
  another Windows account on this computer, or copied to a USB stick, that is an install that downloads nothing (the
  installer unpacks the zips lying beside it — `setup.ps1 -DataDir`, passed by the installer as its own folder).
  Existing installs keep updating through the in-app bar. They don't need the installer.
- Silent / test install: `PokerWrapperSetup.exe /VERYSILENT /KEYFILE=<key.txt> [/STRATEGY=ign200-6max] [/DIR=<folder>]
  [/NOSERVICES]`. `/NOSERVICES` skips the three background services, for a test copy on a machine that already runs
  one. Without `/STRATEGY` a silent install fetches every data part.
- Another copy holding :2000/:8777/:7700 at install time: the SAME Windows user's older copy is stopped and its services
  replaced by the new install (never mid-session). Another ACCOUNT's (the owner's stack, still signed in in the
  background) makes the new install take its own ports: `PORT_OFFSET` in `config\local.env` (the first free of 50,
  100, …) shifts the API, chart server, panel, GTO Wizard CDP and table-browser ports together (`config\env.ps1` and
  `gto-trainer\apps\api\src\services\ports.ts` are the two copies of the rule; the browser pages get their addresses
  rewritten on the way out). Both accounts can then run at once. `/PORTOFFSET=N` sets it on a silent install; the
  checklist header and the "Poker Dashboard" icon say which port the dashboard is on.
- What an install downloads (2026-09-29): the 6-max preflop bake `preflop6` (3,070 MB — every tree in it is
  `ign200_6max`), `nodetrust` (12 MB), the runtime (72 MB, inside the installer), the code (12 MB); the MES turn
  files `mesturn` (216 MB, the 3-max NL25 exploit) only when the strategy needs them. The map is `STRATEGIES` in
  `setup\buildPackage.ts`, shipped in every release's VERSION.json.
