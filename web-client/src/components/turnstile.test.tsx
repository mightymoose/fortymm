import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SCRIPT_SELECTOR = 'script[src*="challenges.cloudflare.com"]'

// The component caches its script promise at module level, so give every test
// a fresh registry — otherwise one test's load attempt would leak into the
// next and decide whether the script even loads.
beforeEach(() => {
  vi.resetModules()
})

async function mountTurnstile(props: {
  onToken: (token: string) => void
  onLoadError?: () => void
}) {
  const { Turnstile } = await import('./turnstile')
  return render(<Turnstile {...props} />)
}

describe('Turnstile', () => {
  it('fires onLoadError when the script fails to load, and suppresses its own alert', async () => {
    const onLoadError = vi.fn()
    await mountTurnstile({ onToken: () => {}, onLoadError })
    expect(onLoadError).not.toHaveBeenCalled()

    // jsdom never fetches external scripts, so drive the load failure the way
    // the browser would: by firing the tag's error event.
    const script = document.head.querySelector(SCRIPT_SELECTOR)
    expect(script).not.toBeNull()
    await act(async () => {
      script?.dispatchEvent(new Event('error'))
    })

    expect(onLoadError).toHaveBeenCalledTimes(1)
    // The host took over failure reporting by supplying onLoadError, so
    // Turnstile's own alert must not double up with the host's (#1498).
    expect(screen.queryByTestId('turnstile-error')).not.toBeInTheDocument()
    // A failed tag must not wedge later mounts: the cached promise resets.
    expect(document.head.querySelector(SCRIPT_SELECTOR)).toBeNull()
  })

  it('renders its own alert on script-load failure when no onLoadError is supplied', async () => {
    await mountTurnstile({ onToken: () => {} })

    const script = document.head.querySelector(SCRIPT_SELECTOR)
    expect(script).not.toBeNull()
    await act(async () => {
      script?.dispatchEvent(new Event('error'))
    })

    expect(screen.getByTestId('turnstile-error')).toBeInTheDocument()
  })

  it('does not fire onLoadError when the API loads', async () => {
    ;(window as { turnstile?: unknown }).turnstile = {
      render: vi.fn(() => 'widget-id'),
      reset: vi.fn(),
      remove: vi.fn(),
    }
    const onLoadError = vi.fn()
    await mountTurnstile({ onToken: () => {}, onLoadError })

    await act(async () => {})
    expect(window.turnstile?.render).toHaveBeenCalled()
    expect(onLoadError).not.toHaveBeenCalled()
  })
})
