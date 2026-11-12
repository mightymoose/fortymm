# Test-only image: runs the cross-app Playwright suite (e2e/), web-client's
# own browser suite (web-client/e2e/, service web-client-e2e) and its icon
# rendering (web-client-icons). The tag must match the exact @playwright/test
# version in e2e/package.json and web-client/e2e/package.json; the image
# carries that version's browsers.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app

# Compose runs this image as the host user (any uid). The node_modules named
# volume takes its permissions from this directory on first mount.
RUN mkdir -p /app/node_modules && chmod 1777 /app/node_modules

COPY --chmod=755 entrypoint.sh /usr/local/bin/dev-entrypoint

# The host user has no home directory in the image; npm and Chromium need one.
ENV HOME=/tmp
ENV npm_config_update_notifier=false

ENTRYPOINT ["dev-entrypoint"]
CMD ["npx", "playwright", "test"]
