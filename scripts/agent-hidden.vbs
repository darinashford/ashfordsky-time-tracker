' Windowless launcher for the teammate sync agent, used by the Scheduled Task so
' nothing flashes on screen every few minutes. Runs scripts\run-agent.ps1 fully
' hidden and waits for it to finish (so the "don't start a second instance" rule
' works). To run by hand:  powershell -File scripts\run-agent.ps1
Dim sh, fso, dir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\run-agent.ps1""", 0, True
