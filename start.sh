#!/bin/sh
# Запуск TechStream на Linux (РЕД ОС и др.). Запуск:  sh start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите: sudo dnf install nodejs"
  echo "(или скачайте версию LTS с https://nodejs.org) и запустите снова."
  exit 1
fi
echo "Версия Node.js: $(node -v)  (нужна 18 или новее)"
( sleep 2; xdg-open http://localhost:3000 >/dev/null 2>&1 ) &
node server.js
