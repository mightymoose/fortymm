# Test-only image: stands in for web-client's production hosting (the Worker
# in web-client/worker/) only where the Worker can't yet: forwarding /api/* to
# the api, for the cross-app suite's api-wiring tests (e2e/tests/health.spec.ts).
# It serves the production build (web-client/dist, bind-mounted) as static
# files. Not for production. Delete it when the Worker's proxy to the api
# lands, and point those tests at web-client-worker.
FROM nginx:1.30-alpine

COPY default.conf /etc/nginx/conf.d/default.conf
