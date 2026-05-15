import { useEffect, useState } from 'react'

/**
 * Returns `value` only after it has stopped changing for `delayMs`. Used to
 * keep fast-changing inputs (e.g. a search box) from firing a request on every
 * keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
