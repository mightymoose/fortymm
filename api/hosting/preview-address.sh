#!/bin/sh
# preview-address.sh <service>
#
# The address of a preview, made from its name:
# https://<service>-<project number>.<region>.run.app, which Cloud Run lists
# beside an older random one. The one place it is made: preview.sh checks
# Cloud Run lists it, and the web client's deploy gives it to the Worker that
# forwards /api/* to the preview (web-client/worker/scripts/api-origin.sh).
# The name must be one preview-name.sh accepts (without --deletable); any
# other is refused. POSIX sh: it runs on the host and in the container.
set -eu

here=$(dirname "$0")
sh "$here/preview-name.sh" "$@" >/dev/null
# shellcheck source=hosting.env
. "$here/hosting.env"
echo "https://$1-$PROJECT_NUMBER.$REGION.run.app"
