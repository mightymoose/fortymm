# Development-only image for api's hosting on Google Cloud: the gcloud CLI,
# pinned, and the Docker CLI, which pushes the api's image through the host's
# Docker (the api-hosting service mounts its socket). It runs
# api/hosting/setup.sh (api:hosting-setup, api:hosting-check) and any gcloud
# command (api:gcloud). Not for production: nothing of it ships.
FROM docker:29.8.2-cli AS docker

FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:593.0.0-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker

# gcloud keeps its login and configuration in the api-hosting-gcloud volume,
# never in the checkout. It sends no usage data and doesn't look for updates:
# the version is the one above.
ENV CLOUDSDK_CONFIG=/gcloud \
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true \
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true

WORKDIR /hosting
