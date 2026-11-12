# Development-only image for web-client's Worker (web-client/worker/). It runs
# Wrangler: the local Workers runtime (wrangler dev, the web-client-worker
# service), the deployment dry run and the deployment itself. Not for
# production: there, Cloudflare runs the Worker.
#
# Debian, not Alpine: the Workers runtime (workerd) needs glibc.
FROM node:26-slim

# The Workers runtime refuses to start without the system's CA certificates.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/worker

# Compose runs this image as the host user (any uid). The node_modules named
# volume takes its permissions from this directory on first mount.
RUN mkdir -p /app/worker/node_modules && chmod 1777 /app/worker/node_modules

COPY --chmod=755 entrypoint.sh /usr/local/bin/dev-entrypoint

# The host user has no home directory in the image; npm and Wrangler need one.
ENV HOME=/tmp
ENV npm_config_update_notifier=false
# Send no usage data to Cloudflare from laptops or CI.
ENV WRANGLER_SEND_METRICS=false

ENTRYPOINT ["dev-entrypoint"]
# The Worker in the local Workers runtime, serving web-client/dist.
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", "--show-interactive-dev-session=false"]
