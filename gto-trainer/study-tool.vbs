' Poker Wrapper TEST RIG launcher - hidden (the "Ignition Study Tool" desktop icon). Runs study-tool.cmd with no
' console window; progress goes to ignition-study-wrapper\debug\study-tool.log. Replaces study-tool.pyw (2026-09-24).
Option Explicit
Dim sh, fso, here
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "cmd /c """"" & here & "\study-tool.cmd""""", 0, False
