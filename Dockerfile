FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 \
  && rm -rf /var/lib/apt/lists/*

ENV MISE_ENV=container \
    MISE_DATA_DIR=/mise \
    PATH=/mise/shims:$PATH

WORKDIR /app
ENTRYPOINT ["/app/bin/docker-entrypoint"]
CMD ["bash"]
