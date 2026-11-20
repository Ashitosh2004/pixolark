@echo off
setlocal
rem =====================================================================
rem  Pixolark launcher (Windows)
rem
rem  Starts the two processes local development needs:
rem    1) the ZERO-DATABASE coordinator :  bun server/src/index.ts  (PORT, default 8787)
rem    2) the app dev server            :  bun run dev  -> vite     (http://localhost:3000)
rem  Each runs in its own window that stays open (cmd /k), so startup
rem  errors are visible instead of flashing away.
rem
rem  Requirements: bun on PATH (https://bun.sh) and a Chromium/Firefox/
rem  Safari browser. This script only launches processes - it never
rem  stores or transmits anything.
rem
rem  Options (set as environment variables BEFORE running this file):
rem    COORD_PORT             coordinator port       (default 8787)
rem    VITE_COORDINATOR_URL   client coordinator URL (default ws://localhost:<COORD_PORT>/coordinator,
rem                           only used when .env does not define one)
rem =====================================================================

cd /d "%~dp0"

rem --- 0. bun must be on PATH ------------------------------------------------
where bun >nul 2>&1
if errorlevel 1 (
    echo [start.bat] ERROR: bun was not found on PATH.
    echo             Install it from https://bun.sh, then open a new shell
    echo             and run start.bat again.
    pause
    exit /b 1
)

rem --- 1. dependencies (first run only) --------------------------------------
if not exist "node_modules" (
    echo [start.bat] node_modules is missing - running "bun install" once...
    bun install
    if errorlevel 1 (
        echo [start.bat] ERROR: bun install failed. Fix the error above and retry.
        pause
        exit /b 1
    )
)

rem --- 2. coordinator port + client URL --------------------------------------
if "%COORD_PORT%"=="" set "COORD_PORT=8787"
set "LOCAL_COORD_URL=ws://localhost:%COORD_PORT%/coordinator"

rem The vite dev server does NOT proxy /coordinator (it answers 404), so the
rem client has to be pointed at the coordinator explicitly for local dev.
rem Precedence, highest first: VITE_COORDINATOR_URL already exported in this
rem shell, a non-empty VITE_COORDINATOR_URL=... line in .env, then the local
rem default above. (.env.example documents the same value.)
set "USE_ENV_COORD="
if defined VITE_COORDINATOR_URL set "USE_ENV_COORD=1"
if exist ".env" (
    findstr /R /C:"^VITE_COORDINATOR_URL=." ".env" >nul 2>&1
    if not errorlevel 1 set "USE_ENV_COORD=1"
)

rem --- 3. coordinator window (stays open on failure) -------------------------
echo [start.bat] starting coordinator on port %COORD_PORT% ...
start "Pixolark coordinator" /D "%~dp0" cmd /k "set PORT=%COORD_PORT%&& bun server/src/index.ts"

rem --- 4. app window (stays open on failure) ---------------------------------
echo [start.bat] starting vite dev server ...
if defined USE_ENV_COORD (
    start "Pixolark app (vite)" /D "%~dp0" cmd /k "bun run dev"
) else (
    start "Pixolark app (vite)" /D "%~dp0" cmd /k "set VITE_COORDINATOR_URL=%LOCAL_COORD_URL%&& bun run dev"
)

rem --- 5. wait until both ports answer, then open the app --------------------
rem First run re-optimizes dependencies, so vite can take a minute or more
rem to be ready (observed: ~80 s cold start).
echo [start.bat] waiting for http://localhost:3000 and ws port %COORD_PORT% ...
set /a WAITED=0
:waitloop
rem HTTP probe over "localhost" (not a raw 127.0.0.1 TCP connect): vite serves
rem on the IPv6 loopback only, and a raw IPv4 socket can never see it.
powershell -NoProfile -Command "try { $a=(Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:3000/).StatusCode; $b=(Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:%COORD_PORT%/health).StatusCode; if ($a -eq 200 -and $b -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
rem ~2 s sleep that also works when stdin is redirected (timeout does not)
ping -n 3 127.0.0.1 >nul
set /a WAITED+=2
if %WAITED% lss 90 goto waitloop
echo [start.bat] WARNING: something did not come up within 90 seconds.
echo             Check the two server windows for errors; opening the app anyway.
goto open

:ready
echo [start.bat] both processes are up.

:open
start "" "http://localhost:3000"
echo.
echo   Coordinator health: http://localhost:%COORD_PORT%/health
echo   App:                http://localhost:3000
echo   The two server windows stay open - close them to stop Pixolark.
echo   Press any key to close THIS launcher window...
pause >nul
exit /b 0
