{{/* Common labels applied to every object. */}}
{{- define "fortymm-uat.labels" -}}
app.kubernetes.io/name: fortymm-uat
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Per-component selector labels. Pass a dict {root, component}. */}}
{{- define "fortymm-uat.selector" -}}
app.kubernetes.io/name: fortymm-uat
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Fully-qualified api image reference. */}}
{{- define "fortymm-uat.apiImage" -}}
{{ .Values.images.api.repository }}:{{ .Values.images.api.tag }}
{{- end -}}

{{/* Fully-qualified web image reference. */}}
{{- define "fortymm-uat.webImage" -}}
{{ .Values.images.web.repository }}:{{ .Values.images.web.tag }}
{{- end -}}

{{/*
Shared env for api / worker / migrate: the non-secret ConfigMap plus the
.env-backed Secret. The APNs key is mounted as a file, not an env var.
*/}}
{{- define "fortymm-uat.appEnvFrom" -}}
- configMapRef:
    name: api-config
- secretRef:
    name: {{ .Values.secrets.env }}
{{- end -}}

{{/*
tailscale serve config — terminates HTTPS on the tailnet node and proxies to
the in-cluster routing nginx Service. ${TS_CERT_DOMAIN} is substituted by the
container with the node's MagicDNS name at startup. Defined here so the
ConfigMap can render it and the Deployment can checksum it (to roll the pod
when the serve config changes).
*/}}
{{- define "fortymm-uat.tailscaleServe" -}}
{
  "TCP": {
    "443": { "HTTPS": true }
  },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": {
        "/": { "Proxy": "http://nginx:80" }
      }
    }
  }
}
{{- end -}}

{{/*
Routing nginx config — mirrors nginx/uat.conf (the docker-compose router).
The `api` and `web-client` upstreams resolve to the same-named k8s Services.
Defined here so the ConfigMap can render it and the Deployment can checksum it
(to roll the pod when the routing changes).
*/}}
{{- define "fortymm-uat.nginxConf" -}}
upstream api_upstream {
    server api:8000;
}

upstream web_upstream {
    server web-client:80;
}

server {
    listen 80;
    server_name _;

    # This nginx listens on :80 behind TLS-terminating host Caddy. With the
    # default `absolute_redirect on` it can't see the external https scheme, so
    # any nginx-generated redirect (e.g. the slash-append 301 on a no-slash
    # location) emits a scheme-DOWNGRADED http:// Location that OAuth/MCP clients
    # refuse to follow. Relative redirects can't downgrade the scheme.
    absolute_redirect off;

    client_max_body_size 25m;

    # /api/* — strip /api and forward to the FastAPI service.
    location /api/ {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Server-Sent Events stream (GET /v1/stream), reached from the SPA via
    # /api/v1/stream. Longer, more-specific prefix than /api/ above, so it wins
    # the longest-prefix match and these streaming settings apply instead of that
    # block's defaults: buffering/caching OFF so each `data:`/`: ping` frame is
    # flushed to the browser immediately, and a read timeout far above both the
    # ~15s keepalive and the 15m stream lifetime so nginx's default 60s doesn't
    # cut the connection. The stream is stateless across api replicas, so no
    # session affinity is needed.
    location /api/v1/stream {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Tolerate clients that strip the trailing slash (e.g. Claude): serve the
    # bare /api/mcp straight from the /mcp/ mount instead of emitting a
    # slash-append 301 that a POST client won't follow.
    location = /api/mcp {
        rewrite ^ /mcp/ break;
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # MCP (FastMCP Streamable-HTTP mount at /mcp) — served to clients via
    # /api/mcp/. This longer, more-specific prefix wins over /api/ above, so the
    # streaming-friendly settings apply: buffering OFF so SSE frames aren't held,
    # and a long read timeout so an idle stream isn't cut at nginx's default 60s
    # (that timeout is a second, independent cause of "session expired" churn).
    # The api transport is stateless (main.py), so no session affinity is needed.
    location /api/mcp/ {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # A bare /mcp/ hit (not via /api/) reaches the same FastMCP mount directly —
    # without this it would fall through to `location /` and land on the SPA.
    location /mcp/ {
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # RFC 9728 protected-resource metadata for the MCP OAuth Resource Server.
    # The server advertises this URL at the PUBLIC ORIGIN ROOT via the 401
    # `WWW-Authenticate: Bearer resource_metadata="…"` challenge on /mcp/, e.g.
    # https://uat.fortymm.com/.well-known/oauth-protected-resource/api/mcp/ — the
    # RFC 9728 path-insertion form. The `/api` there is MID-path (part of the
    # resource identifier), NOT a strippable prefix, so the /api/ rewrite above
    # can't reach it. Internally FastMCP serves the metadata UNDER its mount
    # (/mcp/.well-known/oauth-protected-resource/…), so prepend /mcp to the
    # origin-root path. Unauthenticated by design — discovery precedes any token.
    #
    # The connector requests the NO-slash form (MCP_PUBLIC_RESOURCE_URL has no
    # trailing slash); mapping it straight to the WITH-slash internal path serves
    # 200 directly, so Starlette's redirect_slashes never emits the 307 that was
    # coming back as a scheme-downgraded http:// Location the client won't follow.
    location = /.well-known/oauth-protected-resource/api/mcp {
        rewrite ^ /mcp/.well-known/oauth-protected-resource/api/mcp/ break;
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /.well-known/oauth-protected-resource {
        rewrite ^(.*)$ /mcp$1 break;
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        # Belt-and-suspenders: rewrite any upstream redirect that leaks the
        # internal /mcp mount prefix (and, via Caddy, an http:// downgrade) back
        # into a followable public https URL.
        proxy_redirect ~^https?://([^/]+)/mcp(/.*)$ https://$1$2;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # The MCP server is a Resource Server, NOT an Authorization Server — it does
    # not host AS metadata (Auth0 does). Without these, the paths fall through to
    # `location /` and the SPA answers 200 + index.html, which a strict client
    # mis-reads as metadata. 404 forces the client to use the `authorization_servers`
    # (Auth0) named in the protected-resource metadata above.
    location /.well-known/oauth-authorization-server {
        return 404;
    }
    location /.well-known/openid-configuration {
        return 404;
    }

    # Browser telemetry (Grafana Faro) -> Alloy faro.receiver in the
    # `monitoring` namespace (deploy/observability). resolver + variable
    # upstream so this nginx starts even before the observability release
    # exists (serves 502 on /faro until it does) and picks up a new Alloy
    # ClusterIP without an nginx restart. 10.43.0.10 is the k3d CoreDNS
    # (kube-dns) ClusterIP. Telemetry payloads are small; cap the body size.
    location /faro/ {
        resolver 10.43.0.10 valid=10s;
        set $faro_upstream alloy.monitoring.svc.cluster.local:12347;
        client_max_body_size 5m;
        rewrite ^/faro/(.*)$ /$1 break;
        proxy_pass http://$faro_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Direct (non-/api-prefixed) hit on the SSE stream — curl / API clients.
    #
    # The `^~` is LOAD-BEARING, not stylistic. nginx picks the longest matching
    # PREFIX location, then — unless that prefix was declared `^~` — still runs
    # the regex locations and lets the FIRST matching regex win. A plain
    # `location /v1/stream` would therefore LOSE to the
    # `~ ^/(v1|openapi\.json|docs|redoc)(/|$)` block below, and the stream would
    # silently inherit its proxy_buffering ON + default 60s proxy_read_timeout.
    # `^~` stops the regex phase after the prefix match. Do not "simplify" it.
    location ^~ /v1/stream {
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Direct API paths — FastAPI mounts routes at /v1/*; /openapi.json,
    # /docs, /redoc are FastAPI's defaults.
    location ~ ^/(v1|openapi\.json|docs|redoc)(/|$) {
        proxy_pass http://api_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Built SPA served by nginx inside the web-client container.
    location / {
        proxy_pass http://web_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
{{- end -}}
