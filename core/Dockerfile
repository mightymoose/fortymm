# Build context is the repo root (see docker-compose.yml).
FROM ubuntu:22.04 AS toolchain

# build-essential: the C linker cargo needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl build-essential \
 && rm -rf /var/lib/apt/lists/*

# bin/mise localizes all mise state to /app/.mise, so tools are baked into the image.
WORKDIR /app
COPY bin/mise bin/mise
COPY core/mise.toml core/mise.toml
RUN cd core && /app/bin/mise install

WORKDIR /app/core
ENTRYPOINT ["/app/bin/mise", "exec", "--"]

# The source, with its crates downloaded. The core service (./bin/mise run core:test,
# core:cargo) mounts the checkout over /app/core; build output goes to a named volume.
FROM toolchain AS dev
COPY core/ ./
RUN /app/bin/mise exec -- cargo fetch --locked
ENV CARGO_TARGET_DIR=/opt/core-target
CMD ["cargo", "test", "--locked", "--workspace"]

# The web client's package (wasm-bindgen glue, .wasm and .d.ts) in /out/pkg. web-client/Dockerfile
# copies it in through the core-wasm build context (docker-compose.yml).
FROM dev AS wasm
RUN /app/bin/mise exec -- wasm-pack build bindings/wasm --release --target web --out-dir /out/pkg \
 && rm /out/pkg/.gitignore

# The api's wheel in /out/wheels. api/Dockerfile copies it in through the core-python build
# context (docker-compose.yml).
FROM dev AS python
RUN /app/bin/mise exec -- maturin build --locked --release \
      --manifest-path bindings/python/Cargo.toml --out /out/wheels
