# Development-only PostgreSQL for api. Not for production.
FROM postgres:18-alpine

# Runs once, when the data volume is first created.
COPY init/ /docker-entrypoint-initdb.d/
