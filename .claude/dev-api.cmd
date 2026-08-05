@echo off
rem gto-trainer API (Bun/Hono, :2000) with the ZIP-installed Node on PATH
set "PATH=C:\Users\Brady\AppData\Local\Programs\node-v24.18.0-win-x64;%PATH%"
cd /d C:\Users\Brady\poker\gto-trainer\apps\api
bun run index.ts
