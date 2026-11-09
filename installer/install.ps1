# 마케팅 스킬 명령판 Windows 설치 스크립트
# - 관리자 권한 없이 이 사용자 폴더에만 설치한다. PC 설정은 바꾸지 않는다.
# - Node.js는 nodejs.org 공식 휴대용 판을 받아 설치 폴더 안에만 둔다(지문 SHA-256 검사).
# - 마케팅 스킬은 작업 폴더의 .claude\skills 에만 넣는다. 사용자가 원래 쓰던 Claude 스킬은 건드리지 않는다.
# 시험할 때는 -InstallDir, -WorkDir, -DesktopDir, -Port, -NoLaunch 로 위치를 바꿀 수 있다.
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "MarketingSkillsLauncher"),
  [string]$WorkDir = "",
  [string]$DesktopDir = "",
  [int]$Port = 8787,
  [switch]$NoLaunch,
  [switch]$Update      # 명령판의 [지금 업데이트] 버튼이 붙인다. 화면 없이 돌고, 끝나면 브라우저 탭을 새로 열지 않는다.
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 진행 막대를 끄면 내려받기가 훨씬 빠르다 (PowerShell 5.1)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = "v24.22.1"   # LTS 보안 패치판 (2026-10-20)
$McpVersion  = "0.0.83"     # @playwright/mcp (2026-09-28)
$Src = Split-Path -Parent $PSScriptRoot
if (-not $WorkDir)    { $WorkDir = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "마케팅작업실" }
if (-not $DesktopDir) { $DesktopDir = [Environment]::GetFolderPath("Desktop") }
$Runtime = Join-Path $InstallDir "runtime"
$NodeDir = Join-Path $Runtime "node"
$NodeExe = Join-Path $NodeDir "node.exe"
$Utf8 = New-Object System.Text.UTF8Encoding $false   # BOM 없는 UTF-8 (Node가 JSON을 읽을 때 BOM이 있으면 실패)
# 포트를 실제로 쓰는 프로그램이 있는지 볼 때 쓴다. 상대 주소가 0.0.0.0:0인 줄이 대기 중인 포트다.
# 상태 글자(LISTENING)는 보지 않는다: 일부 Windows 판에서 CLOSED·FIN_WAIT_1로 잘못 찍힌다. PID 0 줄(꺼진 서버 흔적)은 뺀다.
$Listening = ":$Port +0\.0\.0\.0:0 .* [1-9]"
# 서버가 켜져 있는지: 서버가 남긴 app\server.pid의 번호가 살아 있는 node인지 본다 (netstat은 보조).
function ServerUp {
  $f = Join-Path $InstallDir "app\server.pid"
  if (Test-Path $f) {
    $id = 0
    if ([int]::TryParse((Get-Content $f -Raw).Trim(), [ref]$id)) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq "node") { return $true }
    }
  }
  return [bool](netstat -ano | Select-String $Listening)
}

function Step($n, $text) { Write-Host ""; Write-Host "[$n/6] $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  - $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fill($file, $dest) {
  # 틀 파일의 __PORT__ 등을 이 PC 값으로 바꿔 저장한다. .cmd/.vbs는 줄바꿈을 CRLF로 맞춘다.
  $t = [IO.File]::ReadAllText($file, $Utf8)
  $t = $t.Replace("__PORT__", "$Port").Replace("__DESKTOP__", $DesktopDir).Replace("__WORKDIR__", $WorkDir)
  $t = ($t -replace "`r?`n", "`r`n")
  [IO.File]::WriteAllText($dest, $t, $Utf8)
}

Write-Host "마케팅 스킬 명령판 설치를 시작합니다." -ForegroundColor White
Write-Host "  설치 위치: $InstallDir"
Write-Host "  작업 폴더: $WorkDir  (결과물이 여기에 저장됩니다)"

if ($Update) {
  # 화면 없이 돌기 때문에 진행 내용을 파일에 남긴다 (문제가 생기면 이 파일로 원인을 찾는다)
  $updLog = Join-Path $InstallDir "app\logs\update.log"
  try { Start-Transcript -Path $updLog -Append | Out-Null } catch {}
  Write-Host "==== 업데이트 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
}
try {
  if ($Update) {
    # 서버가 스스로 꺼질 때까지 기다린다. 먼저 stop.cmd를 부르면 서버의 자식인 이 스크립트까지 함께 꺼진다.
    $i = 0
    while ($i -lt 60) {
      if (-not (ServerUp)) { break }
      Start-Sleep -Milliseconds 500; $i++
    }
  }
  # 1. 파일 복사 ------------------------------------------------------------
  Step 1 "명령판 파일 복사"
  $stop = Join-Path $InstallDir "stop.cmd"
  if (Test-Path $stop) { & cmd /c "`"$stop`"" | Out-Null; Ok "실행 중이던 명령판을 멈췄습니다." }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $appDest = Join-Path $InstallDir "app"
  New-Item -ItemType Directory -Force -Path $appDest | Out-Null
  # 사용자 설정(config.json)과 실행 기록(jobs, logs)은 남기고 프로그램 파일만 바꾼다
  Get-ChildItem (Join-Path $Src "app") -File | Where-Object { $_.Extension -eq ".js" -or $_.Name -eq "config.example.json" } |
    ForEach-Object { Copy-Item $_.FullName $appDest -Force }
  $pub = Join-Path $appDest "public"
  if (Test-Path $pub) { Remove-Item $pub -Recurse -Force }
  Copy-Item (Join-Path $Src "app\public") $pub -Recurse -Force
  foreach ($name in @("VERSION", "LICENSE", "LICENSE-marketingskills.txt")) { Copy-Item (Join-Path $Src $name) $InstallDir -Force }
  Get-ChildItem (Join-Path $PSScriptRoot "windows") | ForEach-Object { Fill $_.FullName (Join-Path $InstallDir $_.Name) }

  $config = Join-Path $appDest "config.json"
  if (Test-Path $config) {
    $cfg = [IO.File]::ReadAllText($config, $Utf8) | ConvertFrom-Json
    if ($cfg.projectDir) { $WorkDir = $cfg.projectDir }
    Ok "기존 설정을 그대로 씁니다."
  } else {
    $cfg = [ordered]@{ port = $Port; projectDir = $WorkDir }
    [IO.File]::WriteAllText($config, ($cfg | ConvertTo-Json), $Utf8)
  }
  Ok "버전 $(([IO.File]::ReadAllText((Join-Path $Src 'VERSION'))).Trim())"

  # 2. Node.js -------------------------------------------------------------
  Step 2 "Node.js $NodeVersion 준비 (명령판을 돌리는 프로그램)"
  $have = if (Test-Path $NodeExe) { (& $NodeExe -v) } else { "" }
  if ($have -eq $NodeVersion) {
    Ok "이미 설치되어 있습니다."
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $name = "node-$NodeVersion-win-$arch"
    $base = "https://nodejs.org/dist/$NodeVersion"
    $tmp = Join-Path $env:TEMP "msl-node-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
      Write-Host "  nodejs.org 에서 내려받는 중... (약 30MB)"
      Invoke-WebRequest "$base/$name.zip" -OutFile "$tmp\$name.zip" -UseBasicParsing
      Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile "$tmp\SHASUMS256.txt" -UseBasicParsing
      $line = Get-Content "$tmp\SHASUMS256.txt" | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))$" }
      $expect = ($line -split "\s+")[0]
      $actual = (Get-FileHash "$tmp\$name.zip" -Algorithm SHA256).Hash
      if (-not $expect -or $expect -ne $actual.ToLower()) { throw "내려받은 Node.js 파일의 지문이 공식 값과 다릅니다. 인터넷 연결을 확인하고 다시 실행해 주세요." }
      Ok "파일 지문 확인 완료"
      & tar -xf "$tmp\$name.zip" -C $tmp
      if ($LASTEXITCODE -ne 0) { Expand-Archive "$tmp\$name.zip" $tmp -Force }
      New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
      if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
      Move-Item "$tmp\$name" $NodeDir
      Ok "설치 완료 ($(& $NodeExe -v))"
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }

  # 3. 브라우저 도구 --------------------------------------------------------
  Step 3 "브라우저 자동 조사 도구 준비 (네이버 등 페이지 읽기)"
  $mcpDir = Join-Path $Runtime "mcp"
  $cli = Join-Path $mcpDir "node_modules\@playwright\mcp\cli.js"
  $pkg = Join-Path $mcpDir "node_modules\@playwright\mcp\package.json"
  $mcpFile = Join-Path $appDest "mcp.json"
  try {
    $cur = if (Test-Path $pkg) { ([IO.File]::ReadAllText($pkg) | ConvertFrom-Json).version } else { "" }
    if ($cur -ne $McpVersion) {
      New-Item -ItemType Directory -Force -Path $mcpDir | Out-Null
      & (Join-Path $NodeDir "npm.cmd") install --prefix $mcpDir "@playwright/mcp@$McpVersion" --no-audit --no-fund --loglevel=error
      if ($LASTEXITCODE -ne 0) { throw "npm 설치 실패" }
    }
    # 이미 깔린 브라우저를 쓴다. 크롬이 있으면 크롬, 없으면 Windows에 기본으로 있는 엣지.
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { $_ -and (Test-Path $_) }
    $browser = if ($chrome) { "chrome" } else { "msedge" }
    $mcp = @{ mcpServers = @{ playwright = @{ command = $NodeExe; args = @($cli, "--headless", "--browser", $browser) } } }
    [IO.File]::WriteAllText($mcpFile, ($mcp | ConvertTo-Json -Depth 5), $Utf8)
    Ok "준비 완료 (브라우저: $browser, 화면 없이 실행)"
  } catch {
    if (Test-Path $mcpFile) { Remove-Item $mcpFile -Force }
    Warn "브라우저 도구를 준비하지 못했습니다. 명령판은 쓸 수 있지만 네이버처럼 막힌 페이지는 못 읽습니다. ($($_.Exception.Message))"
  }

  # 4. 마케팅 스킬 ----------------------------------------------------------
  Step 4 "마케팅 스킬 52개를 작업 폴더에 넣기"
  $skillDest = Join-Path $WorkDir ".claude\skills"
  New-Item -ItemType Directory -Force -Path $skillDest | Out-Null
  $count = 0
  Get-ChildItem (Join-Path $Src "skills") -Directory | ForEach-Object {
    $d = Join-Path $skillDest $_.Name
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }   # 이 설치판이 넣는 스킬만 새로 바꾼다
    Copy-Item $_.FullName $d -Recurse -Force
    $count++
  }
  Copy-Item (Join-Path $Src "skills\SOURCE.md") $skillDest -Force
  Ok "$($count)개 설치: $skillDest"   # $count개 로 쓰면 한글까지 변수 이름으로 읽힌다

  # 5. 바탕화면 아이콘 ------------------------------------------------------
  Step 5 "바탕화면 아이콘 만들기"
  # 옛 판(0.2.0 이하)의 아이콘 이름. 이름만 봐도 켜는 버튼인지 알 수 있게 '켜기'를 붙였다.
  $oldLnk = Join-Path $DesktopDir "마케팅 스킬 명령판.lnk"
  $newLnk = Join-Path $DesktopDir "마케팅 스킬 명령판 켜기.lnk"
  if ($Update) {
    if ((Test-Path $oldLnk) -and -not (Test-Path $newLnk)) {
      Move-Item $oldLnk $newLnk
      Ok "아이콘 이름을 '마케팅 스킬 명령판 켜기'로 바꿨습니다."
    } else { Ok "업데이트라 기존 아이콘을 그대로 씁니다." }
  } else {
  New-Item -ItemType Directory -Force -Path $DesktopDir | Out-Null
  if (Test-Path $oldLnk) { Remove-Item $oldLnk -Force }   # 다시 설치할 때 옛 이름 아이콘이 겹쳐 남지 않게
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($newLnk)
  $lnk.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
  $lnk.Arguments = "`"$(Join-Path $InstallDir 'start.vbs')`""
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
  $lnk.Description = "마케팅 스킬 명령판 열기"
  $lnk.Save()
  Ok "바탕화면에 '마케팅 스킬 명령판 켜기' 아이콘을 만들었습니다."
  }

  # 6. 실행 -----------------------------------------------------------------
  Step 6 "명령판 열기"
  if ($NoLaunch) { Ok "시험 모드라 열지 않습니다." }
  elseif ($Update) {
    # 열려 있던 브라우저 탭이 새 버전을 알아채고 저절로 새로고침한다
    Start-Process cmd.exe "/c `"`"$(Join-Path $InstallDir 'start.cmd')`" nobrowser`"" -WindowStyle Hidden
    $up = $false
    for ($i = 0; $i -lt 20 -and -not $up; $i++) { Start-Sleep -Milliseconds 500; $up = ServerUp }
    if ($up) { Ok "새 버전으로 다시 켰습니다." } else { Warn "명령판을 다시 켜지 못했습니다. 바탕화면의 '마케팅 스킬 명령판 켜기'로 켜 주세요." }
  }
  else {
    Start-Process (Join-Path $env:SystemRoot "System32\wscript.exe") "`"$(Join-Path $InstallDir 'start.vbs')`""
    Ok "브라우저에 명령판이 열립니다. 다음부터는 바탕화면의 '마케팅 스킬 명령판 켜기'를 누르세요."
  }
  Write-Host ""
  Write-Host "설치를 마쳤습니다." -ForegroundColor Green
  if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")) {
    Warn "Claude Code가 아직 없습니다. 명령판 첫 화면의 '시작 준비' 안내를 따라 설치해 주세요."
  }
  exit 0
} catch {
  Write-Host ""
  Write-Host "설치 중 문제가 생겼습니다: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "이 창 내용을 사진으로 찍어 문의해 주세요."
  if ($Update) {
    # 업데이트가 중간에 실패해도 명령판이 꺼진 채로 남지 않게 다시 켠다
    $startCmd = Join-Path $InstallDir "start.cmd"
    if (Test-Path $startCmd) { Start-Process cmd.exe "/c `"`"$startCmd`" nobrowser`"" -WindowStyle Hidden }
  }
  exit 1
}
