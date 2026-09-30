#!/bin/sh
# Run the persistence API locally for `npm run dev` (Vite proxies /api here).
# There is no oauth2-proxy in local dev, so DEV_USER_EMAIL stands in for the
# signed-in user. The API ignores it when NODE_ENV=production.
set -eu

cd "$(dirname "$0")/../server"

: "${DATABASE_URL:?Set DATABASE_URL, e.g. postgres://chartdb:<password>@localhost:5432/chartdb}"
: "${DEV_USER_EMAIL:=dev@nczgroup.com}"
export DATABASE_URL DEV_USER_EMAIL

[ -d node_modules ] || npm ci

exec node --watch index.ts
