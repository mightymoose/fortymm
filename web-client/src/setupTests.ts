import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom doesn't implement scrollTo, which the router calls on navigation.
window.scrollTo = () => {}

afterEach(() => {
  cleanup()
})
