' Starts the AWI Resolve support service with no console window.
' Used only by local/self-hosted installs — when the agent is pointed at a
' hosted connector (wss://…) there is nothing to start on the PC.
Set shell = CreateObject("WScript.Shell")
base = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
shell.Run """" & base & "\node.exe"" """ & base & "\orchestrator\server.js""", 0, False
