# Development-only image for web-client. Not for production.
FROM node:26-alpine

WORKDIR /app

# Compose runs this image as the host user (any uid). The node_modules named
# volume takes its permissions from this directory on first mount, so make it
# writable by whichever uid that is.
RUN mkdir -p /app/node_modules && chmod 1777 /app/node_modules

COPY --chmod=755 entrypoint.sh /usr/local/bin/dev-entrypoint

USER node
# The host user has no home directory in the image; npm needs a writable one.
ENV HOME=/tmp
ENV npm_config_update_notifier=false

ENTRYPOINT ["dev-entrypoint"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
