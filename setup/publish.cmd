@echo off
rem Publish a Poker Wrapper update to your friends (owner machine). Shows what changed, asks for notes, gates, uploads.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
