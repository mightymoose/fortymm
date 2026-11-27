# Build context is the repo root (see docker-compose.yml).
FROM ubuntu:22.04 AS toolchain

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 xz-utils \
 && rm -rf /var/lib/apt/lists/*

# bin/mise localizes all mise state to /app/.mise, so tools are baked into the image.
WORKDIR /app
COPY bin/mise bin/mise
COPY web-client/mise.toml web-client/mise.toml
RUN cd web-client && /app/bin/mise install

WORKDIR /app/web-client
ENTRYPOINT ["/app/bin/mise", "exec", "--"]

# Dependencies are baked into the image. Compose mounts the source over /app/web-client
# with an anonymous volume on node_modules, so each container starts from this copy.
FROM toolchain AS dev
# The core's wasm package (core/bindings/wasm), from the core-wasm build context
# (docker-compose.yml). package.json depends on it as file:../core/bindings/wasm/pkg.
COPY --from=core-wasm /out/pkg /app/core/bindings/wasm/pkg
COPY web-client/package.json web-client/package-lock.json ./
RUN /app/bin/mise exec -- npm ci
# Playwright browser (Chromium) and its system libraries, at the version in the lockfile.
# Baked into the image so e2e tests run in this same container.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN /app/bin/mise exec -- npx playwright install --with-deps chromium
CMD ["npm", "run", "dev"]

# The production build (tsc -b, then vite build into dist/), for preview's nginx.
FROM dev AS build
COPY web-client/ ./
RUN /app/bin/mise exec -- npm run build

# Preview (web-client-public): nginx serves the build and proxies /api (see nginx.conf).
FROM nginx:1.27-alpine AS serve
COPY web-client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web-client/dist /usr/share/nginx/html
