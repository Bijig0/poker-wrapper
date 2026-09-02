@echo off
rem 3-max HRC chart server on :8777 (R2-backed lazy-fetch solve DB). Required for 3-handed study answers.
cd /d C:\Users\Brady\poker\analysis\pipeline\solve
"C:\Users\Brady\poker\aof-model\.venv\Scripts\python.exe" -m exploit_ui.server
