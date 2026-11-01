@echo off
rem Stops the marketing skill launcher server (port __PORT__).
rem 1) The server writes its PID to app\server.pid. Kill it only if that PID is still a node.exe.
set "SRVPID="
if exist "%~dp0app\server.pid" set /p SRVPID=<"%~dp0app\server.pid"
if defined SRVPID (
  tasklist /fi "PID eq %SRVPID%" /fi "IMAGENAME eq node.exe" /nh | findstr /b /i "node.exe" >nul && taskkill /PID %SRVPID% /T /F >nul 2>&1
)
del "%~dp0app\server.pid" >nul 2>&1
rem 2) Fallback (older versions without a PID file): the listening line has remote address 0.0.0.0:0.
rem    Do not rely on the state word; some Windows builds print it wrong or drop the line.
for /f "tokens=4,5" %%a in ('netstat -ano ^| findstr /r /c:":__PORT__  *0\.0\.0\.0:0 .* [1-9]"') do (
  if "%%b"=="" (taskkill /PID %%a /T /F >nul 2>&1) else (taskkill /PID %%b /T /F >nul 2>&1)
)
