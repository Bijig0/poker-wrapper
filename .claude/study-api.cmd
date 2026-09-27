@echo off
rem "PokerWrapper API - <user>" scheduled task entry point: the real supervisor (restart loop + hang watchdog) is study-api.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0study-api.ps1"
