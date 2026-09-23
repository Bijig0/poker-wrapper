@echo off
rem Poker Wrapper - one-click launcher (the desktop shortcut runs run-study.pyw, which does the same plus a
rem cache purge and takeover). The venv python comes from config\env.ps1, not a machine path (2026-09-22).
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
"%PYTHON%" "%~dp0launch.py" %*
