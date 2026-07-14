@echo off
REM Ashford Sky Time Tracker - scheduled capture + attribution.
REM Runs ActivityWatch ingest, then the resolver. Logs to %TEMP%\ashfordsky-tt.log.
cd /d "C:\Users\darin\OneDrive - Ashford Sky CPA LLC\Claude Code\Time Tracker"
echo ---- %date% %time% ---- >> "%TEMP%\ashfordsky-tt.log"
call corepack pnpm@9.12.3 --filter @tt/activitywatch-ingestor run start >> "%TEMP%\ashfordsky-tt.log" 2>&1
call corepack pnpm@9.12.3 --filter @tt/resolver-service run start -- --days 3 >> "%TEMP%\ashfordsky-tt.log" 2>&1
REM Capture + OCR fresh email windows, then re-resolve so OCR'd senders attribute.
call corepack pnpm@9.12.3 --filter @tt/screenshot-sidecar run start >> "%TEMP%\ashfordsky-tt.log" 2>&1
call corepack pnpm@9.12.3 --filter @tt/resolver-service run start -- --days 3 >> "%TEMP%\ashfordsky-tt.log" 2>&1
