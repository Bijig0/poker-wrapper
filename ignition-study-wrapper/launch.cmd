@echo off
rem Poker Wrapper - the PYTHON wrapper, kept as the fallback (2026-09-24). The desktop shortcut now runs the
rem TypeScript one (run-wrapper.vbs hidden; wrapper.cmd with a console). This and run-study.pyw start the Python
rem one; either replaces the other on the same panel port. The venv python comes from config\env.ps1.
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
"%PYTHON%" "%~dp0launch.py" %*
