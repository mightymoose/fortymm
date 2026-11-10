# Development-only image for web-client. Not for production.
FROM node:26-alpine

WORKDIR /app

# The node_modules named volume takes its ownership from this directory on
# first mount, so the unprivileged node user can install into it.
RUN mkdir -p /app/node_modules && chown node:node /app /app/node_modules

COPY --chmod=755 web-client-entrypoint.sh /usr/local/bin/dev-entrypoint

USER node
ENV npm_config_update_notifier=false

ENTRYPOINT ["dev-entrypoint"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
