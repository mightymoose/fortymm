# The api image as it ships: the locked runtime dependencies, the core's Python
# module and the app, no dev tools, run by uvicorn as an unprivileged user.
# Configure it with DATABASE_URL and ENVIRONMENT. The end-to-end suite runs
# this image (the api-release service).
#
# Build it with the core's source as a second context named `core`, as
# compose.dev.yaml does: docker build --build-context core=../core api
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv
# The same Rust as dev/core/Dockerfile; change both together.
FROM rust:1.99.1-slim-trixie AS rust

# The core's Python module (stable ABI), built from source with the same
# Python the image runs, as core:python builds it.
FROM python:3.15-slim AS core-module
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
WORKDIR /core
COPY --from=core . .
RUN cargo build --locked --release --package fortymm-core-python \
 && cp target/release/libfortymm_core.so /fortymm_core.abi3.so

FROM python:3.15-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
# Dependencies first, so a source change doesn't reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

FROM python:3.15-slim
RUN useradd --system --uid 10001 --no-create-home api
COPY --from=build /opt/venv /opt/venv
COPY --from=core-module /fortymm_core.abi3.so /opt/venv/lib/python3.15/site-packages/
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1
USER api
EXPOSE 8000
# Fail the build, not the first request, if the module does not load here.
RUN python -c "import fortymm_core"
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
