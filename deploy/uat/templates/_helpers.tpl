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
