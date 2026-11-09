#!/bin/bash
# 명령판 프로그램을 지운다. 작업 폴더(결과물·사업 정보)는 남긴다.
echo "마케팅 스킬 명령판을 지웁니다."
echo "작업 폴더(결과물·사업 정보)는 지우지 않습니다: __WORKDIR__"
read -r -p "계속할까요? (y/n) " a
[ "$a" = "y" ] || exit 0
"__INSTALL__/stop.sh"
# 휴대폰 접속(Tailscale)을 켜 두었다면 이 명령판 포트만 끈다 (다른 Tailscale 설정은 그대로)
for ts in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if command -v "$ts" >/dev/null 2>&1 || [ -x "$ts" ]; then "$ts" serve --https=__PORT__ off >/dev/null 2>&1; break; fi
done
rm -f "__DESKTOP__/마케팅 스킬 명령판 켜기.command" "__DESKTOP__/마케팅 스킬 명령판.command"
rm -rf "__INSTALL__"
echo "지웠습니다."
