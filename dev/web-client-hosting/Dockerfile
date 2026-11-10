# Test-only image: stands in for web-client's production hosting (Cloudflare
# Workers, not in this repository yet) for the cross-app suite in e2e/. It
# serves the production build (web-client/dist, bind-mounted) as static files.
# Not for production. When the real hosting lands, point the suite at it (for
# example the Workers runtime run locally) and delete this image.
FROM nginx:1.30-alpine

COPY default.conf /etc/nginx/conf.d/default.conf
