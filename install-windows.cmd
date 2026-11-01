@chcp 65001 >nul
@echo off
rem Double-click to install. Runs installer\install.ps1 for this user only (no admin rights).
if not exist "%~dp0installer\install.ps1" (
  echo 압축을 먼저 풀어 주세요. 내려받은 zip 파일을 오른쪽 클릭 - "압축 풀기" 후 다시 실행하세요.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
echo.
pause
