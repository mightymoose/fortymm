# Build context is the repo root (see docker-compose.yml).
FROM ubuntu:22.04 AS toolchain

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# bin/mise localizes all mise state to /app/.mise, so tools are baked into the image.
WORKDIR /app
COPY bin/mise bin/mise
COPY api/mise.toml api/mise.toml
RUN cd api && /app/bin/mise install

WORKDIR /app/api
# uv uses mise's Python rather than downloading its own.
ENV UV_PYTHON_DOWNLOADS=never
ENTRYPOINT ["/app/bin/mise", "exec", "--"]

# Dependencies are baked into the image. Compose mounts the source over /app/api with an
# anonymous volume on .venv, so each container starts from this copy.
FROM toolchain AS dev
COPY api/pyproject.toml api/uv.lock ./
RUN /app/bin/mise exec -- uv sync --locked --no-install-project
CMD ["fastapi", "dev", "app/main.py", "--host", "0.0.0.0", "--port", "8000"]
