#!/bin/sh
# Run the persistence API locally for `npm run dev` (Vite proxies /api here).
# There is no nginx in local dev, so DEV_USER stands in for the logged-in
# user. The API ignores it when NODE_ENV=production.
set -eu

cd "$(dirname "$0")/../server"

: "${DATABASE_URL:?Set DATABASE_URL, e.g. postgres://chartdb:<password>@localhost:5432/chartdb}"
: "${DEV_USER:=dev}"
export DATABASE_URL DEV_USER

[ -d node_modules ] || npm ci

exec node --watch index.ts
