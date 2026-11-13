# Test-only stand-in for the api: answers every request with what it
# received (server.mjs), for the cross-app suite's proxy rules. Not the api,
# and not for production.
FROM node:26-alpine

COPY server.mjs /srv/server.mjs
USER node
EXPOSE 8080
CMD ["node", "/srv/server.mjs"]
