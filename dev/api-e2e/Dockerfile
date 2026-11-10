# Test-only image: runs api's end-to-end suite (e2e/api/) with pytest. The
# suite is bind-mounted at /app and its venv lives in a named volume.
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

FROM python:3.15-slim
COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app

# Compose runs this image as the host user (any uid); see dev/api/Dockerfile.
RUN mkdir -p /opt/venvs && chmod 1777 /opt/venvs

COPY --chmod=755 entrypoint.sh /usr/local/bin/dev-entrypoint

ENV HOME=/tmp \
    UV_PROJECT_ENVIRONMENT=/opt/venvs/api-e2e \
    UV_CACHE_DIR=/opt/venvs/.uv-cache \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH=/opt/venvs/api-e2e/bin:$PATH

ENTRYPOINT ["dev-entrypoint"]
CMD ["pytest"]
