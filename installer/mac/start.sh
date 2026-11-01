#!/bin/bash
# 마케팅 스킬 명령판을 켜고(이미 켜져 있으면 그대로) 브라우저로 연다.
cd "__INSTALL__" || exit 1
mkdir -p app/logs
if ! lsof -nP -iTCP:__PORT__ -sTCP:LISTEN >/dev/null 2>&1; then
  nohup runtime/node/bin/node app/server.js >> app/logs/server.log 2>&1 &
  disown
  sleep 2
fi
# 업데이트 뒤에는 이미 열린 탭이 저절로 새로고침되므로 새 탭을 열지 않는다
[ "${1:-}" = "nobrowser" ] && exit 0
open "http://127.0.0.1:__PORT__/"
echo "명령판을 열었습니다. 이 창은 닫아도 됩니다."
