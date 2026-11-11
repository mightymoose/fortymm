# Development-only image for core: a pinned Rust toolchain, plus the two hosts
# that load what core builds, Node (the WebAssembly build) and Python (the
# server's module; the same Python as dev/api). The source is bind-mounted at
# /app; cargo's download cache and all build output live in a named volume at
# /opt/core.
FROM rust:1.99.1-slim-trixie AS rust
FROM node:26-slim AS node

FROM python:3.15-slim

# A C linker for cargo, and binaryen for wasm-opt (core:wasm reports the size
# of the WebAssembly file with and without it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev binaryen \
 && rm -rf /var/lib/apt/lists/*

# The toolchain, copied whole from the official image so its version is the
# tag above and nothing else.
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=node /usr/local/bin/node /usr/local/bin/node

ENV RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH
RUN CARGO_HOME=/usr/local/cargo rustup component add clippy rustfmt \
 && CARGO_HOME=/usr/local/cargo rustup target add wasm32-unknown-unknown

COPY --chmod=755 install.sh /usr/local/bin/dev-install

WORKDIR /app

# Compose runs this image as the host user (any uid). The cache volume takes
# its permissions from this directory on first mount, so make it writable by
# whichever uid that is.
RUN mkdir -p /opt/core && chmod 1777 /opt/core

# The host user has no home directory in the image. Downloads and build output
# go to the volume, so nothing cargo writes lands in the checkout.
ENV HOME=/tmp \
    CARGO_HOME=/opt/core/cargo \
    CARGO_TARGET_DIR=/opt/core/target \
    PYTHONDONTWRITEBYTECODE=1

CMD ["cargo", "test", "--locked", "--workspace"]
