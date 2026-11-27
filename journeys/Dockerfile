# Build context is the repo root (see docker-compose.yml).
FROM ubuntu:22.04 AS toolchain

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 xz-utils \
 && rm -rf /var/lib/apt/lists/*

# bin/mise localizes all mise state to /app/.mise, so tools are baked into the image.
WORKDIR /app
COPY bin/mise bin/mise
COPY journeys/mise.toml journeys/mise.toml
RUN cd journeys && /app/bin/mise install

WORKDIR /app/journeys
ENTRYPOINT ["/app/bin/mise", "exec", "--"]

# Dependencies and Chromium are baked into the image. Compose mounts the source over
# /app/journeys with an anonymous volume on node_modules, so each container starts from this copy.
FROM toolchain AS dev
COPY journeys/package.json journeys/package-lock.json ./
RUN /app/bin/mise exec -- npm ci
# The web client's page objects (mounted at /app/web-client/e2e) import @playwright/test. Looking up
# from there finds this package's copy, for both Node and tsc.
RUN ln -s /app/journeys/node_modules /app/node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN /app/bin/mise exec -- npx playwright install --with-deps chromium
CMD ["npx", "playwright", "test"]
