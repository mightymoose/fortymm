# Development-only tool image: openapi-typescript, which turns api/openapi.json
# into web-client/src/api/schema.gen.ts (web-client:api-types and
# web-client:api-types-check). It runs on TypeScript 5's compiler API, which
# web-client's TypeScript 7 does not have, so it can't be a web-client
# devDependency. Versions are locked in package-lock.json next to this file.
FROM node:26-alpine

WORKDIR /opt/web-client-openapi
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
ENV PATH=/opt/web-client-openapi/node_modules/.bin:$PATH \
    HOME=/tmp \
    npm_config_update_notifier=false

# Compose mounts web-client at /app and api/openapi.json read-only at
# /contracts/api/openapi.json.
WORKDIR /app
