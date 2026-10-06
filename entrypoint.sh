#!/bin/sh
set -eu

# Fail closed: refuse to start without the shared password or database.
: "${APP_PASSWORD:?APP_PASSWORD is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${APP_USERNAME:=ncz}"
export APP_USERNAME

PUBLIC_PORT="${PORT:-80}"
API_PORT=13000
if [ "$PUBLIC_PORT" = "$API_PORT" ]; then
    echo "PORT=$PUBLIC_PORT is reserved for internal use; choose another port" >&2
    exit 1
fi
export PUBLIC_PORT API_PORT

# Runtime config as a static file, so it sits behind the login like any other
# asset (an nginx `return` would bypass auth_request).
node /app/server/write-runtime-config.ts > /usr/share/nginx/html/config.js

# Replace placeholders in nginx.conf
envsubst '${PUBLIC_PORT} ${API_PORT}' < /etc/nginx/http.d/default.conf.template > /etc/nginx/http.d/default.conf

node /app/server/index.ts &
API_PID=$!
nginx -g 'daemon off;' &
NGINX_PID=$!

stopping=false
trap 'stopping=true; kill -TERM $API_PID $NGINX_PID 2>/dev/null || true' TERM INT

# Exit as soon as either process dies so the container restarts cleanly.
while kill -0 $API_PID 2>/dev/null && kill -0 $NGINX_PID 2>/dev/null; do
    sleep 2
done

kill -TERM $API_PID $NGINX_PID 2>/dev/null || true
wait
if [ "$stopping" = true ]; then exit 0; fi
echo "A service exited unexpectedly; stopping container" >&2
exit 1
