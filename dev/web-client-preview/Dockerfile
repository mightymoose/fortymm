# Test-only image: serves web-client's production build (web-client/dist,
# bind-mounted) as static files for the end-to-end suite. Not for production.
FROM nginx:1.30-alpine

COPY default.conf /etc/nginx/conf.d/default.conf
