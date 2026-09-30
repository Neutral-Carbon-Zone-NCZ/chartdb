#!/bin/sh
set -eu

# Fail closed: refuse to start without Google OAuth and database settings.
: "${OAUTH2_PROXY_CLIENT_ID:?OAUTH2_PROXY_CLIENT_ID is required}"
: "${OAUTH2_PROXY_CLIENT_SECRET:?OAUTH2_PROXY_CLIENT_SECRET is required}"
: "${OAUTH2_PROXY_COOKIE_SECRET:?OAUTH2_PROXY_COOKIE_SECRET is required}"
: "${OAUTH2_PROXY_REDIRECT_URL:?OAUTH2_PROXY_REDIRECT_URL is required (https://<host>/oauth2/callback)}"
: "${DATABASE_URL:?DATABASE_URL is required}"

# Google sign-in restricted to the company domain. The API re-checks it.
: "${ALLOWED_EMAIL_DOMAINS:=nczgroup.com}"
: "${OAUTH2_PROXY_EMAIL_DOMAINS:=$ALLOWED_EMAIL_DOMAINS}"
: "${OAUTH2_PROXY_PROVIDER:=google}"
: "${OAUTH2_PROXY_HTTP_ADDRESS:=0.0.0.0:${PORT:-80}}"
: "${OAUTH2_PROXY_UPSTREAMS:=http://127.0.0.1:8080/}"
: "${OAUTH2_PROXY_REVERSE_PROXY:=true}"
: "${OAUTH2_PROXY_SKIP_PROVIDER_BUTTON:=true}"
: "${OAUTH2_PROXY_COOKIE_SECURE:=true}"
: "${OAUTH2_PROXY_PASS_USER_HEADERS:=true}"
# Return 401 (not a Google redirect) for expired sessions on API calls.
: "${OAUTH2_PROXY_API_ROUTES:=^/api/}"
export ALLOWED_EMAIL_DOMAINS OAUTH2_PROXY_EMAIL_DOMAINS OAUTH2_PROXY_PROVIDER \
    OAUTH2_PROXY_HTTP_ADDRESS OAUTH2_PROXY_UPSTREAMS OAUTH2_PROXY_REVERSE_PROXY \
    OAUTH2_PROXY_SKIP_PROVIDER_BUTTON OAUTH2_PROXY_COOKIE_SECURE \
    OAUTH2_PROXY_PASS_USER_HEADERS OAUTH2_PROXY_API_ROUTES

# Replace placeholders in nginx.conf
envsubst '${OPENAI_API_KEY} ${OPENAI_API_ENDPOINT} ${LLM_MODEL_NAME} ${HIDE_CHARTDB_CLOUD} ${DISABLE_ANALYTICS}' < /etc/nginx/http.d/default.conf.template > /etc/nginx/http.d/default.conf

node /app/server/index.ts &
API_PID=$!
nginx -g 'daemon off;' &
NGINX_PID=$!
oauth2-proxy &
PROXY_PID=$!

stopping=false
trap 'stopping=true; kill -TERM $API_PID $NGINX_PID $PROXY_PID 2>/dev/null || true' TERM INT

# Exit as soon as any process dies so the container restarts cleanly.
while kill -0 $API_PID 2>/dev/null && kill -0 $NGINX_PID 2>/dev/null && kill -0 $PROXY_PID 2>/dev/null; do
    sleep 2
done

kill -TERM $API_PID $NGINX_PID $PROXY_PID 2>/dev/null || true
wait
if [ "$stopping" = true ]; then exit 0; fi
echo "A service exited unexpectedly; stopping container" >&2
exit 1
