{{/* Common labels applied to objects this chart defines directly. */}}
{{- define "observability.labels" -}}
app.kubernetes.io/name: observability
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
tailscale serve config for one proxy. Pass the backend URL as the context.
${TS_CERT_DOMAIN} is substituted by the container with the node's MagicDNS
name at startup. Mirrors deploy/fortymm's fortymm.tailscaleServe helper.
*/}}
{{- define "observability.tailscaleServe" -}}
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": { "/": { "Proxy": {{ . | quote }} } }
    }
  }
}
{{- end -}}
