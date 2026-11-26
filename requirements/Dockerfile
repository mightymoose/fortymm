# Build context is the repo root (see docker-compose.yml).
FROM ubuntu:22.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libicu70 \
 && rm -rf /var/lib/apt/lists/*

# bin/mise localizes all mise state to /app/.mise, so tools are baked into the image.
WORKDIR /app
COPY bin/mise bin/mise
COPY requirements/mise.toml requirements/mise.toml
RUN cd requirements && /app/bin/mise install

WORKDIR /app/requirements
ENTRYPOINT ["/app/bin/mise", "exec", "--", "/app/requirements/scripts/verify.sh"]
