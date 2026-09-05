import { vi } from 'vitest'

/** Works with both jsdom Storage and the Node 26 setup shim. */
export function blockLocalStorage(method: 'getItem' | 'setItem'): void {
  vi.stubGlobal('localStorage', new Proxy(localStorage, {
    get(target, key) {
      if (key === method) return () => { throw new DOMException('Storage unavailable', 'QuotaExceededError') }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
}
