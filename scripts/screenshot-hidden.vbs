' Windowless launcher for the teammate screenshot loop, used by the Scheduled Task
' so nothing flashes on screen. Runs scripts\run-screenshot.ps1 fully hidden and
' waits for it to finish. To run by hand:  powershell -File scripts\run-screenshot.ps1
Dim sh, fso, dir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\run-screenshot.ps1""", 0, True
