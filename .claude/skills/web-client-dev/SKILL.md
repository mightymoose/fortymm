---
name: web-client-dev
description: Start the web-client (Vite + React) dev server in its Docker container and report its URL. Use when asked to run, start, or open the web client or its dev server, or to see a web-client change in the browser.
---

# Start the web-client dev server

1. From the repo root, run `./bin/mise run web-client:dev` with Bash `run_in_background: true`. It never exits on its own.
2. Wait for this line in its output (the first run builds the image and can take a minute):
   `web-client dev server: http://localhost:<port>  (container <id>)`
   Give the user that URL. Ignore Vite's `localhost:5173` line: that is the port inside the container.
3. The host port is random, so several dev servers can run at once. `./bin/mise run ports` lists the ones that are running.

To stop it, run `docker stop <id>` with the container id from step 2. Only stop containers by exact id: never by a label or name filter, which can match other checkouts' containers.
