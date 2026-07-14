@echo off
REM Registers the 15-minute capture+resolve scheduled task. Run from anywhere.
schtasks /Create /TN "AshfordSkyTimeTracker" /SC MINUTE /MO 15 /IT /F /TR "\"%~dp0run-pipeline.cmd\""
if %ERRORLEVEL%==0 (
  echo.
  echo Created "AshfordSkyTimeTracker" - runs every 15 minutes while you are logged in.
  echo Remove it later with: scripts\uninstall-task.cmd
) else (
  echo.
  echo Failed to create the task. Try running this file from an Administrator terminal.
)
