' AWI Resolve — starts the support agent with no visible console window.
' Launched at logon by the "AWI Resolve Agent" scheduled task, and once by the
' installer so support is available immediately.
Dim sh, fso, appDir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = appDir
' 0 = hidden window, False = don't wait. node.exe + agent are bundled alongside.
sh.Run """" & appDir & "\node.exe"" ""agent\agent.js""", 0, False
