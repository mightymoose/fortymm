FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 \
  && rm -rf /var/lib/apt/lists/*

ENV MISE_ENV=container \
    MISE_DATA_DIR=/mise \
    PATH=/mise/shims:$PATH

# uv uses mise's Python rather than downloading its own, and copies packages
# into the venv volume (its cache is on another filesystem).
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

WORKDIR /app
ENTRYPOINT ["/app/bin/docker-entrypoint"]
CMD ["bash"]
