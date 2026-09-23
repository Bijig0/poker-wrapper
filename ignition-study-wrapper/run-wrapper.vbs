' Poker Wrapper - hidden launcher (the desktop shortcut and update.ps1 -Relaunch run this).
'
' Starts wrapper.cmd with no console window and the log going to server.log beside this file, the way
' run-study.pyw did for the Python wrapper. Arguments pass through (--panel-port N --cdp-port N --fake).
' Launching replaces whatever instance is serving that panel port, the Python wrapper included.
Option Explicit
Dim sh, fso, here, args, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
If sh.Environment("Process")("WRAPPER_LOG_FILE") = "" Then sh.Environment("Process")("WRAPPER_LOG_FILE") = here & "\server.log"
sh.CurrentDirectory = here
' cmd /c ""<script>" args" - cmd strips the outer pair, so a path with spaces survives
sh.Run "cmd /c """"" & here & "\wrapper.cmd""" & args & """", 0, False
