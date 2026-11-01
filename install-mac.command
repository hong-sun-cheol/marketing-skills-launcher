#!/bin/bash
# 더블클릭으로 설치. 처음 열 때 "확인되지 않은 개발자" 경고가 뜨면 오른쪽 클릭 - 열기로 실행한다.
cd "$(dirname "$0")" || exit 1
bash installer/install.sh
echo
read -r -p "엔터를 누르면 창이 닫힙니다." _
