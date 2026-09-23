# Poker Wrapper — installing on your laptop

The Poker Wrapper sits beside your poker table and shows a study answer for each decision, and a dashboard
(in your browser) for looking back at your sessions and hands. It works with **Ignition** and **CoinPoker**.

Plan on about **30–45 minutes** the first time, most of it downloads. You can stop at any point and run setup
again later — it skips everything that is already done.

---

## Before you start

**You need:**
- A Windows 10 or 11 laptop with **10 GB free** and an internet connection.
- Two monitors is best (the table on one, the answers on the other), but one works.

**From the person who gave you this:**
- `PokerWrapper-code-<version>.zip` (about 15 MB). That's all you need to be handed; setup downloads the
  rest (about 2 GB) by itself.
- `PokerWrapper-key.txt`, the **download key** (charts, data and updates come through it). Keep it to
  yourself and don't share it on.

**Your own accounts:**
- **GTO Wizard** with a plan that includes GTO Wizard AI (Ultra). The answers after the flop come from it.
- **Ignition** and/or **CoinPoker**.

> ⚠️ **Read this first.** Using any tool like this while playing for real money is against Ignition's and
> CoinPoker's terms, and CoinPoker actively scans for software it doesn't like. The risk to your accounts is
> yours. Never sit at the same table as the person who gave you this.

---

## 1. Unzip

1. Make a folder, e.g. `C:\Poker`.
2. Right-click `PokerWrapper-code-<version>.zip` → **Extract All…** → into `C:\Poker`.
   You now have `C:\Poker\PokerWrapper\…`
3. Put `PokerWrapper-key.txt` in `C:\Poker` too, next to the `PokerWrapper` folder.

```
C:\Poker\
   PokerWrapper\             ← the code
   PokerWrapper-key.txt      ← the key
```

(If you were also given `PokerWrapper-data-….zip` files, e.g. on a USB stick, put them in `C:\Poker` next to the
`PokerWrapper` folder and leave them zipped. Setup uses them instead of downloading.)

## 2. Run setup

1. Open `C:\Poker\PokerWrapper\setup\` and double-click **`setup.cmd`**.
   - If Windows says *"Windows protected your PC"*: **More info → Run anyway**.
2. It installs what it needs (Python, Bun, rclone, Chrome, Brave). A few installer windows may flash by.
3. It picks up the key file by itself (nothing to type), then downloads the chart data (about 2 GB, the slowest
   part).
4. At the end it runs a **checklist**. Green `[ok]` is good; red `[!!]` has a line under it saying what to do.
   Right after setup it is normal for **GTO Wizard signed in** to be red — that's the next step.

## 3. Sign in to GTO Wizard (once)

A Chrome window opens on **app.gtowizard.com** (setup starts it; if you don't see it, wait a minute — it comes
back by itself). **Sign in** with your GTO Wizard account and leave that window open (you can minimise it).

This Chrome window is separate from your normal Chrome — that's on purpose. Always leave it running while you play.

Check: double-click `setup\doctor.cmd` → **GTO Wizard signed in** should be `[ok]`.

If it ever says you're signed out (or you closed that window), double-click **`setup\gtow-signin.cmd`** and sign
in again.

**Which GTO Wizard plan:** the answers after the flop, and the multiway spots, are solved live by GTO Wizard AI
on your account, so you need a plan with GTO Wizard AI — **Ultra** covers everything (6-max multiway, 3-way flops,
heads-up). It uses your account's daily solve allowance while you play.

## 4. Your poker accounts

**CoinPoker:** install it from coinpoker.com and sign in, as usual. That's all — the Poker Wrapper reads the table
from CoinPoker's own log file, so you sit down in CoinPoker yourself like always.

**Ignition:** the Poker Wrapper signs you in for you:
1. Double-click **Poker Wrapper** on your desktop. The *Session setup* page opens.
2. Choose **Site: Ignition**, then under *Table* click **profiles…**
3. Enter a name, your Ignition e-mail and password → **Save profile**.
   The password goes into Windows Credential Manager on your laptop — nowhere else.

## 5. Play

1. Open **Poker Wrapper** (desktop icon).
2. **Site**: Ignition or CoinPoker.
3. **Mode**: pick the strategy for your game (each card says which tables it's built for).
4. **Table**: the format you're playing (and for Ignition, your profile).
5. Wait for **Preflight** to go green, then **Start session**.
   - Ignition: it opens the table window and takes you to a table.
   - CoinPoker: open CoinPoker and sit down; the panel follows the table you sit at. Answers come for
     **heads-up NL200** (the "CoinPoker 200NL Heads-Up" strategy). Other CoinPoker tables are read and recorded,
     but get no answers yet.
6. When it's your turn, the panel shows the answer. **End session** when you're done.

## 6. Looking back at your hands

Open **http://localhost:2000** in any browser: **Hands** and **Sessions** have everything you played, with the
answer shown for each decision.

---

## When something's wrong

1. Double-click **`setup\doctor.cmd`** and fix what's red (each red line says how).
2. Most "not answering" problems go away after **restarting the laptop** — everything starts by itself at logon.
3. Still stuck? Send a **screenshot of the doctor window** to the person who gave you this.

**Updates:** when a new version is out, the Poker Wrapper's setup page shows a blue **Update available** bar
with what's new. Press **Update now** (you can't during a session, so end it first). A window shows the progress,
then the Poker Wrapper reopens by itself. Your settings, sign-ins and hand history are kept.

You can also update any time by double-clicking `setup\update.cmd`. If a new version has a problem, the person
who gave you this can tell you which version to go back to: `setup\update.cmd -Version <that version>`.

**Uninstall:** run `powershell -ExecutionPolicy Bypass -File setup\install_tasks.ps1 -Uninstall`, then delete
`C:\Poker` and the desktop icon.
