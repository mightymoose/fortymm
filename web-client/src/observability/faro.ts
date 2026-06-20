let started = false

/**
 * Initialize Grafana Faro browser telemetry — uncaught errors, console logs,
 * web-vitals, and traces (forwarded to Loki/Tempo by the Alloy faro.receiver).
 *
 * Enabled only when VITE_FARO_COLLECTOR_URL is set, which happens just in the
 * UAT build (`/faro/collect`, routed same-origin to Alloy). In local dev,
 * tests, and the QA build the var is empty, so this is a no-op — no telemetry
 * leaves the browser. The SDK is dynamically imported behind that build-time
 * gate so the heavy Faro/OpenTelemetry tree stays out of the entry chunk (and
 * is dropped entirely from builds where the URL is empty).
 */
export async function initFaro(): Promise<void> {
  if (started || typeof window === 'undefined') return
  const url = import.meta.env.VITE_FARO_COLLECTOR_URL
  if (!url) return
  started = true

  const [{ getWebInstrumentations, initializeFaro }, { TracingInstrumentation }] =
    await Promise.all([
      import('@grafana/faro-web-sdk'),
      import('@grafana/faro-web-tracing'),
    ])

  initializeFaro({
    url,
    app: {
      name: 'fortymm-web',
      version: import.meta.env.VITE_APP_VERSION || 'uat',
      environment: import.meta.env.VITE_FARO_ENVIRONMENT || 'uat',
    },
    instrumentations: [...getWebInstrumentations(), new TracingInstrumentation()],
  })
}
