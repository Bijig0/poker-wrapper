@echo off
rem Update the Poker Wrapper to the latest release. Safe to run any time; it refuses while a session is running.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
