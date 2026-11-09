@chcp 65001 >nul
@echo off
rem Removes the launcher program. The work folder (results, business info) is kept.
echo 마케팅 스킬 명령판을 지웁니다.
echo 작업 폴더(결과물·사업 정보)는 지우지 않습니다: __WORKDIR__
choice /m "계속할까요"
if errorlevel 2 exit /b
call "%~dp0stop.cmd"
rem If phone access (Tailscale) was turned on, turn off only this launcher's port.
if exist "%ProgramFiles%\Tailscale\tailscale.exe" "%ProgramFiles%\Tailscale\tailscale.exe" serve --https=__PORT__ off >nul 2>&1
del "__DESKTOP__\마케팅 스킬 명령판 켜기.lnk" >nul 2>&1
del "__DESKTOP__\마케팅 스킬 명령판.lnk" >nul 2>&1
set "TARGET=%~dp0"
echo 지웠습니다. 이 창은 닫아도 됩니다.
rem "(goto) 2>nul" ends reading this file first, so cmd does not complain after the folder is gone.
(goto) 2>nul & cd /d "%TEMP%" & rmdir /s /q "%TARGET%"
