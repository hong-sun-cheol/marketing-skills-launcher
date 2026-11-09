#!/bin/bash
# 마케팅 스킬 명령판 Mac 설치 스크립트 (아직 실제 Mac에서 시험하지 않음)
# - 관리자 권한 없이 이 사용자 폴더에만 설치한다.
# - Node.js는 nodejs.org 공식 판을 받아 설치 폴더 안에만 둔다(지문 SHA-256 검사).
# - 마케팅 스킬은 작업 폴더의 .claude/skills 에만 넣는다.
# 시험할 때는 환경 변수 INSTALL_DIR, WORK_DIR, DESKTOP_DIR, PORT, NO_LAUNCH=1 로 바꿀 수 있다.
# 명령판의 [지금 업데이트] 버튼은 UPDATE=1 을 붙여 부른다 (화면 없이 돌고, 브라우저 탭을 새로 열지 않음).
set -euo pipefail

NODE_VERSION="v24.22.1"   # LTS 보안 패치판 (2026-10-20)
MCP_VERSION="0.0.83"      # @playwright/mcp (2026-09-28)
SRC="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Library/Application Support/MarketingSkillsLauncher}"
WORK_DIR="${WORK_DIR:-$HOME/Documents/마케팅작업실}"
DESKTOP_DIR="${DESKTOP_DIR:-$HOME/Desktop}"
PORT="${PORT:-8787}"
RUNTIME="$INSTALL_DIR/runtime"
NODE_DIR="$RUNTIME/node"
NODE_BIN="$NODE_DIR/bin/node"

step() { printf '\n\033[36m[%s/6] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '  \033[32m- %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
fill() { sed -e "s|__PORT__|$PORT|g" -e "s|__INSTALL__|$INSTALL_DIR|g" -e "s|__DESKTOP__|$DESKTOP_DIR|g" -e "s|__WORKDIR__|$WORK_DIR|g" "$1" > "$2"; chmod +x "$2"; }
fail() {
  printf '\n\033[31m설치 중 문제가 생겼습니다: %s\033[0m\n이 창 내용을 사진으로 찍어 문의해 주세요.\n' "$1"
  # 업데이트가 중간에 실패해도 명령판이 꺼진 채로 남지 않게 다시 켠다
  if [ "${UPDATE:-}" = "1" ] && [ -x "$INSTALL_DIR/start.sh" ]; then "$INSTALL_DIR/start.sh" nobrowser >/dev/null 2>&1 || true; fi
  exit 1
}
trap 'fail "줄 $LINENO 에서 멈췄습니다."' ERR

echo "마케팅 스킬 명령판 설치를 시작합니다."
echo "  설치 위치: $INSTALL_DIR"
echo "  작업 폴더: $WORK_DIR  (결과물이 여기에 저장됩니다)"

if [ "${UPDATE:-}" = "1" ]; then
  # 서버가 스스로 꺼질 때까지 기다린다 (최대 30초)
  for _ in $(seq 60); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
fi

# 1. 파일 복사 ---------------------------------------------------------------
step 1 "명령판 파일 복사"
[ -x "$INSTALL_DIR/stop.sh" ] && "$INSTALL_DIR/stop.sh" >/dev/null 2>&1 && ok "실행 중이던 명령판을 멈췄습니다." || true
mkdir -p "$INSTALL_DIR/app"
# 사용자 설정(config.json)과 실행 기록(jobs, logs)은 남기고 프로그램 파일만 바꾼다
cp "$SRC/app/"*.js "$SRC/app/config.example.json" "$INSTALL_DIR/app/"
rm -rf "$INSTALL_DIR/app/public"
cp -R "$SRC/app/public" "$INSTALL_DIR/app/public"
cp "$SRC/VERSION" "$SRC/LICENSE" "$SRC/LICENSE-marketingskills.txt" "$INSTALL_DIR/"
for f in "$SRC/installer/mac/"*; do fill "$f" "$INSTALL_DIR/$(basename "$f")"; done
CONFIG="$INSTALL_DIR/app/config.json"
if [ -f "$CONFIG" ]; then
  ok "기존 설정을 그대로 씁니다."
else
  printf '{\n  "port": %s,\n  "projectDir": "%s"\n}\n' "$PORT" "$WORK_DIR" > "$CONFIG"
fi
ok "버전 $(cat "$SRC/VERSION")"

# 2. Node.js -----------------------------------------------------------------
step 2 "Node.js $NODE_VERSION 준비 (명령판을 돌리는 프로그램)"
if [ -x "$NODE_BIN" ] && [ "$("$NODE_BIN" -v)" = "$NODE_VERSION" ]; then
  ok "이미 설치되어 있습니다."
else
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  NAME="node-$NODE_VERSION-darwin-$ARCH"
  BASE="https://nodejs.org/dist/$NODE_VERSION"
  TMP="$(mktemp -d)"
  echo "  nodejs.org 에서 내려받는 중... (약 50MB)"
  curl -fsSL "$BASE/$NAME.tar.gz" -o "$TMP/$NAME.tar.gz"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  EXPECT="$(grep " $NAME.tar.gz\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$TMP/$NAME.tar.gz" | awk '{print $1}')"
  [ -n "$EXPECT" ] && [ "$EXPECT" = "$ACTUAL" ] || fail "내려받은 Node.js 파일의 지문이 공식 값과 다릅니다. 인터넷 연결을 확인하고 다시 실행해 주세요."
  ok "파일 지문 확인 완료"
  tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
  mkdir -p "$RUNTIME"; rm -rf "$NODE_DIR"; mv "$TMP/$NAME" "$NODE_DIR"; rm -rf "$TMP"
  ok "설치 완료 ($("$NODE_BIN" -v))"
fi

# 3. 브라우저 도구 -----------------------------------------------------------
step 3 "브라우저 자동 조사 도구 준비 (네이버 등 페이지 읽기)"
MCP_DIR="$RUNTIME/mcp"
CLI="$MCP_DIR/node_modules/@playwright/mcp/cli.js"
MCP_FILE="$INSTALL_DIR/app/mcp.json"
BROWSER=""
[ -d "/Applications/Google Chrome.app" ] && BROWSER=chrome
[ -z "$BROWSER" ] && [ -d "/Applications/Microsoft Edge.app" ] && BROWSER=msedge
if [ -z "$BROWSER" ]; then
  rm -f "$MCP_FILE"
  warn "크롬이나 엣지가 없어 건너뜁니다. 명령판은 쓸 수 있지만 네이버처럼 막힌 페이지는 못 읽습니다."
else
  CUR="$("$NODE_BIN" -e "try{console.log(require('$MCP_DIR/node_modules/@playwright/mcp/package.json').version)}catch{}" 2>/dev/null || true)"
  if [ "$CUR" = "$MCP_VERSION" ] || PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install --prefix "$MCP_DIR" "@playwright/mcp@$MCP_VERSION" --no-audit --no-fund --loglevel=error; then
    "$NODE_BIN" -e 'const [f,n,c,b]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({mcpServers:{playwright:{command:n,args:[c,"--headless","--browser",b]}}},null,2))' "$MCP_FILE" "$NODE_BIN" "$CLI" "$BROWSER"
    ok "준비 완료 (브라우저: $BROWSER, 화면 없이 실행)"
  else
    rm -f "$MCP_FILE"
    warn "브라우저 도구를 준비하지 못했습니다. 명령판은 쓸 수 있지만 네이버처럼 막힌 페이지는 못 읽습니다."
  fi
fi

# 4. 마케팅 스킬 -------------------------------------------------------------
step 4 "마케팅 스킬 52개를 작업 폴더에 넣기"
SKILL_DEST="$WORK_DIR/.claude/skills"
mkdir -p "$SKILL_DEST"
COUNT=0
for d in "$SRC/skills/"*/; do
  n="$(basename "$d")"
  rm -rf "$SKILL_DEST/$n"   # 이 설치판이 넣는 스킬만 새로 바꾼다
  cp -R "$d" "$SKILL_DEST/$n"
  COUNT=$((COUNT + 1))
done
cp "$SRC/skills/SOURCE.md" "$SKILL_DEST/"
ok "${COUNT}개 설치: $SKILL_DEST"

# 5. 바탕화면 아이콘 ---------------------------------------------------------
step 5 "바탕화면 아이콘 만들기"
# 옛 판(0.2.0 이하)의 아이콘 이름. 이름만 봐도 켜는 버튼인지 알 수 있게 '켜기'를 붙였다.
OLD_ICON="$DESKTOP_DIR/마케팅 스킬 명령판.command"
NEW_ICON="$DESKTOP_DIR/마케팅 스킬 명령판 켜기.command"
if [ "${UPDATE:-}" = "1" ]; then
  if [ -f "$OLD_ICON" ] && [ ! -e "$NEW_ICON" ]; then
    mv "$OLD_ICON" "$NEW_ICON"; ok "아이콘 이름을 '마케팅 스킬 명령판 켜기'로 바꿨습니다."
  else ok "업데이트라 기존 아이콘을 그대로 씁니다."; fi
else
  # 아이콘은 설치 폴더의 start.sh를 부르기만 한다. 업데이트로 start.sh가 바뀌어도 그대로 쓸 수 있다.
  mkdir -p "$DESKTOP_DIR"
  rm -f "$OLD_ICON"   # 다시 설치할 때 옛 이름 아이콘이 겹쳐 남지 않게
  printf '#!/bin/bash\nexec "%s/start.sh"\n' "$INSTALL_DIR" > "$NEW_ICON"
  chmod +x "$NEW_ICON"
  ok "바탕화면에 '마케팅 스킬 명령판 켜기' 아이콘을 만들었습니다."
fi

# 6. 실행 --------------------------------------------------------------------
step 6 "명령판 열기"
if [ "${NO_LAUNCH:-}" = "1" ]; then ok "시험 모드라 열지 않습니다."
elif [ "${UPDATE:-}" = "1" ]; then "$INSTALL_DIR/start.sh" nobrowser; ok "새 버전으로 다시 켰습니다."
else "$INSTALL_DIR/start.sh"; ok "브라우저에 명령판이 열립니다. 다음부터는 바탕화면의 '마케팅 스킬 명령판 켜기'를 누르세요."; fi

printf '\n\033[32m설치를 마쳤습니다.\033[0m\n'
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  warn "Claude Code가 아직 없습니다. 명령판 첫 화면의 '시작 준비' 안내를 따라 설치해 주세요."
fi
