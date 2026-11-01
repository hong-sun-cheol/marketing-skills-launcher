@echo off
rem Starts the marketing skill launcher (if not already running) and opens it in the browser.
cd /d "%~dp0"
if not exist "app\logs" mkdir "app\logs"
rem Already running? The server writes its PID to app\server.pid (netstat is unreliable on some Windows builds).
set "SRVPID="
if exist "app\server.pid" set /p SRVPID=<"app\server.pid"
if not defined SRVPID goto launch
tasklist /fi "PID eq %SRVPID%" /fi "IMAGENAME eq node.exe" /nh | findstr /b /i "node.exe" >nul && goto opened
:launch
start "" /b cmd /c ""runtime\node\node.exe" app\server.js >> app\logs\server.log 2>&1"
ping -n 3 127.0.0.1 >nul
:opened
rem After an update the open tab reloads by itself, so do not open a new one.
if /i "%~1"=="nobrowser" exit /b
start "" "http://127.0.0.1:__PORT__/"
