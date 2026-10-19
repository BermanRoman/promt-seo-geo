#!/usr/bin/env bash
# Заливка собранного сайта на хостинг по SSH (rsync). Куда — из workspace/.env:
#   DEPLOY_HOST — алиас из ~/.ssh/config или user@host (ключ настраивает навык «Инфраструктура»);
#   DEPLOY_DIR  — папка сайта на сервере (например www/blog.example.ru).
# --delete убирает с сервера страницы, которых больше нет; файлы подтверждения прав и .well-known (сертификат) не трогаются.
set -euo pipefail
cd "$(dirname "$0")/.."
WS="${WORKSPACE:-../workspace}"
env_val() { grep -E "^$1=" "$WS/.env" 2>/dev/null | head -1 | cut -d= -f2- || true; }
HOST="${DEPLOY_HOST:-$(env_val DEPLOY_HOST)}"
DIR="${DEPLOY_DIR:-$(env_val DEPLOY_DIR)}"
test -n "$HOST" -a -n "$DIR" || { echo "нет DEPLOY_HOST или DEPLOY_DIR в $WS/.env — сначала навык «Инфраструктура»"; exit 1; }
test -f dist/index.html || { echo "нет dist/ — сначала npm run build"; exit 1; }
# защита от пустого сайта: без материалов rsync --delete стёр бы сайт на сервере
test "$(find dist -name index.html | wc -l)" -gt 3 || { echo "в dist/ почти нет страниц — заливка остановлена"; exit 1; }
rsync -az --delete --checksum --exclude=".well-known/" --exclude="google*.html" --exclude="yandex_*.html" dist/ "$HOST:$DIR/"
echo "залито в $HOST:$DIR"
mkdir -p "$WS/.deploy" && date '+%Y-%m-%d %H:%M' > "$WS/.deploy/deployed"
node scripts/post-deploy.mjs || echo "post-deploy: ошибка, публикация не затронута"
