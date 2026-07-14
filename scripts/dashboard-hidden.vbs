' Windowless launcher for the Time Tracker dashboard server. Starts it fully
' hidden and returns immediately (the server keeps running in the background).
' Used by the "AshfordSky-TimeTracker-Dashboard" Scheduled Task at logon.
' To run the dashboard by hand instead, use:
'   powershell -File scripts\start-dashboard.ps1
Dim sh, fso, dir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\start-dashboard.ps1""", 0, False
