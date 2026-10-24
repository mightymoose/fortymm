# check=skip=InvalidDefaultArgInFrom
# The production image of the API, deployed to Cloud Run (see CLAUDE.md's
# Deploy section). The dev image is the repo root's Dockerfile.
#
# Build it with `./bin/mise run api:build`, which reads both versions from
# mise.container.toml so the image runs the same Python and uv as the dev
# container. (Hence no defaults, and the check=skip directive at the top.)
ARG PYTHON_VERSION
ARG UV_VERSION

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# Resolve and install the dependencies into /app/.venv.
FROM python:${PYTHON_VERSION}-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
# Use the image's Python, never a download, and install a regular (not
# editable) copy of the project so the venv works without the source.
ENV UV_PYTHON_PREFERENCE=only-system \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_EDITABLE=1
WORKDIR /app
# Dependencies first, so editing the source doesn't reinstall them.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    uv sync --locked --no-dev --no-install-project
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev

# Just the interpreter and the venv, run as an unprivileged user.
FROM python:${PYTHON_VERSION}-slim-trixie
RUN useradd --system --uid 10001 --no-create-home app
COPY --from=build /app/.venv /app/.venv
# The API migrates at startup with alembic.ini from its working directory.
WORKDIR /app
COPY alembic.ini ./
COPY migrations ./migrations
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PORT=8080
USER app
# Cloud Run sets PORT. The Cloudflare Worker forwards /api/* here with the
# prefix stripped, so --root-path makes /api/docs load the schema, as in dev;
# the proxy headers carry the client's scheme and address.
CMD ["sh", "-c", "exec uvicorn fortymm_api.main:app --host 0.0.0.0 --port \"$PORT\" --root-path /api --proxy-headers --forwarded-allow-ips='*'"]
