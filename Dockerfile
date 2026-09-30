FROM node:24-alpine AS builder

ARG VITE_OPENAI_API_KEY
ARG VITE_OPENAI_API_ENDPOINT
ARG VITE_LLM_MODEL_NAME
ARG VITE_HIDE_CHARTDB_CLOUD
ARG VITE_DISABLE_ANALYTICS

WORKDIR /usr/src/app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN echo "VITE_OPENAI_API_KEY=${VITE_OPENAI_API_KEY}" > .env && \
    echo "VITE_OPENAI_API_ENDPOINT=${VITE_OPENAI_API_ENDPOINT}" >> .env && \
    echo "VITE_LLM_MODEL_NAME=${VITE_LLM_MODEL_NAME}" >> .env && \
    echo "VITE_HIDE_CHARTDB_CLOUD=${VITE_HIDE_CHARTDB_CLOUD}" >> .env && \
    echo "VITE_DISABLE_ANALYTICS=${VITE_DISABLE_ANALYTICS}" >> .env

RUN npm run build

FROM node:24-alpine AS server-deps

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM quay.io/oauth2-proxy/oauth2-proxy:v7.15.4 AS oauth2-proxy

FROM node:24-alpine AS production

RUN apk add --no-cache nginx gettext && rm -f /etc/nginx/http.d/default.conf

COPY --from=oauth2-proxy /bin/oauth2-proxy /usr/local/bin/oauth2-proxy
COPY --from=builder /usr/src/app/dist /usr/share/nginx/html
COPY --from=server-deps /app/server/node_modules /app/server/node_modules
COPY server/package.json server/index.ts /app/server/
COPY ./default.conf.template /etc/nginx/http.d/default.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-80}/ping" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
