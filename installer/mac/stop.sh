#!/bin/bash
# 마케팅 스킬 명령판 서버(포트 __PORT__)를 멈춘다.
PIDS="$(lsof -nP -tiTCP:__PORT__ -sTCP:LISTEN 2>/dev/null)"
[ -n "$PIDS" ] && kill $PIDS
exit 0
