# Development-only image for api: Python and uv. Not for production; that
# image is api/Dockerfile. The source is bind-mounted at /app and the virtual
# environment lives in a named volume at /opt/venvs.
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

FROM python:3.15-slim
COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app

# Compose runs this image as the host user (any uid). The venv volume takes its
# permissions from this directory on first mount, so make it writable by
# whichever uid that is.
RUN mkdir -p /opt/venvs && chmod 1777 /opt/venvs

COPY --chmod=755 entrypoint.sh /usr/local/bin/dev-entrypoint
COPY --chmod=755 install.sh /usr/local/bin/dev-install

# The host user has no home directory in the image. The venv is a directory
# inside the volume, not the mount point itself, so uv can recreate it; uv's
# download cache sits beside it so reinstalls are quick.
ENV HOME=/tmp \
    UV_PROJECT_ENVIRONMENT=/opt/venvs/api \
    UV_CACHE_DIR=/opt/venvs/.uv-cache \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH=/opt/venvs/api/bin:$PATH

ENTRYPOINT ["dev-entrypoint"]
CMD ["uvicorn", "api.main:app", "--reload", "--reload-dir", "src", "--host", "0.0.0.0", "--port", "8000"]
