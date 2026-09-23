@echo off
rem 3-max HRC chart server on :8777 (R2-backed lazy-fetch solve DB). Required for 3-handed study answers.
rem where everything is: config\env.ps1 (repo root from this file, the venv python, HRC_UI_DOC_CACHE_MAX=6 -
rem six parsed trees resident, ~4GB: a ring session's working set, so hero's turn never waits on a cold open)
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\config\env.ps1" -EmitCmd`) do %%L
cd /d "%POKER_ROOT%\analysis\pipeline\solve"
"%PYTHON%" -m exploit_ui.server
