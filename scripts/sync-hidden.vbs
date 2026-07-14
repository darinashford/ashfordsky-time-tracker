' Windowless launcher for the Time Tracker sync, used by the Scheduled Task so
' nothing flashes on screen every few minutes. Runs scripts\sync.ps1 fully hidden
' and waits for it to finish (so the task's "don't start a second instance" rule
' works). To run the sync by hand, just use:  powershell -File scripts\sync.ps1
Dim sh, fso, dir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\sync.ps1""", 0, True
