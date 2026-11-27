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
COPY web-client/package.json web-client/package-lock.json ./
RUN /app/bin/mise exec -- npm ci
CMD ["npm", "run", "dev"]
