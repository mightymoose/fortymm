import { useEffect, useRef, useState } from 'react'

/**
 * Cloudflare Turnstile widget. Defaults to the documented always-passes test
 * site key (`1x00000000000000000000AA`) so dev and tests work with no setup;
 * production should set `VITE_TURNSTILE_SITE_KEY`.
 */
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string
      callback?: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
      theme?: 'light' | 'dark' | 'auto'
    },
  ) => string
  reset: (widgetId?: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no-window'))
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    )
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.turnstile) resolve(window.turnstile)
        else reject(new Error('turnstile-missing-after-load'))
      })
      existing.addEventListener('error', () => reject(new Error('script-load-failed')))
      return
    }
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile)
      else reject(new Error('turnstile-missing-after-load'))
    }
    script.onerror = () => reject(new Error('script-load-failed'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

export interface TurnstileHandle {
  reset: () => void
}

export function Turnstile({
  onToken,
  onExpire,
  onError,
  handleRef,
}: {
  onToken: (token: string) => void
  onExpire?: () => void
  onError?: () => void
  handleRef?: (handle: TurnstileHandle | null) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const apiRef = useRef<TurnstileApi | null>(null)
  const [failed, setFailed] = useState(false)

  // Hold the latest callbacks in refs so we can render the widget once and
  // not have its callbacks go stale across re-renders.
  const onTokenRef = useRef(onToken)
  const onExpireRef = useRef(onExpire)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onTokenRef.current = onToken
    onExpireRef.current = onExpire
    onErrorRef.current = onError
  })

  useEffect(() => {
    let cancelled = false
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return
        apiRef.current = api
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey:
            import.meta.env.VITE_TURNSTILE_SITE_KEY ?? TURNSTILE_TEST_SITE_KEY,
          theme: 'dark',
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onExpireRef.current?.(),
          'error-callback': () => {
            onErrorRef.current?.()
          },
        })
        handleRef?.({
          reset: () => {
            if (apiRef.current && widgetIdRef.current) {
              apiRef.current.reset(widgetIdRef.current)
            }
          },
        })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      if (apiRef.current && widgetIdRef.current) {
        try {
          apiRef.current.remove(widgetIdRef.current)
        } catch {
          // ignore — widget may have already torn down
        }
      }
      widgetIdRef.current = null
      handleRef?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failed) {
    return (
      <p
        className="fmm-help fmm-help--err"
        role="alert"
        data-testid="turnstile-error"
      >
        Couldn't load CAPTCHA. Check your network and reload.
      </p>
    )
  }

  return <div ref={containerRef} data-testid="turnstile-widget" />
}
