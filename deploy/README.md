# deploy/

Kubernetes deployment artifacts for fortymm. Currently this stands up the
web-client only and routes HTTP traffic to it via an Ingress.

## Layout

```
deploy/
└── helm/
    └── web-client/   Helm chart for the Vite + React SPA (served by nginx)
```

The `Dockerfile` and `nginx.conf` for the web-client image live next to the
app source in [`web-client/`](../web-client).

## Build the image

From the repo root:

```sh
docker build -t ghcr.io/mightymoose/fortymm-web-client:dev web-client
```

The image is a multi-stage build: Node builds the static bundle, then
nginx (running as non-root on port 8080) serves `dist/` with an SPA
fallback to `index.html` and a `/healthz` probe endpoint.

## Install the chart

```sh
helm upgrade --install web-client deploy/helm/web-client \
  --namespace fortymm --create-namespace \
  --set image.tag=dev
```

Useful overrides:

| Flag | Effect |
| --- | --- |
| `--set image.repository=...` / `--set image.tag=...` | Point at a different image |
| `--set ingress.enabled=false` | Skip the Ingress (e.g. when port-forwarding) |
| `--set ingress.hosts[0].host=fortymm.example.com` | Change the host the Ingress matches |
| `--set ingress.className=nginx` | Pin a specific IngressClass |
| `--set replicaCount=3` | Scale replicas (or enable `autoscaling`) |

## Local smoke test

```sh
# Render manifests without touching a cluster.
helm template web-client deploy/helm/web-client

# Lint the chart.
helm lint deploy/helm/web-client
```

To try it on a local cluster (kind / minikube / k3d), build the image,
load it into the cluster, then `helm upgrade --install` as above. With
the default `fortymm.local` host, add an `/etc/hosts` entry pointing at
your ingress controller's external IP.
