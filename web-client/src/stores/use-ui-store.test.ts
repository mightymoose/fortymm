import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore } from './use-ui-store'

const initialState = useUiStore.getState()

describe('useUiStore', () => {
  beforeEach(() => {
    useUiStore.setState(initialState, true)
  })

  it('starts with the sidebar closed', () => {
    expect(useUiStore.getState().sidebarOpen).toBe(false)
  })

  it('opens, closes, and toggles the sidebar', () => {
    useUiStore.getState().openSidebar()
    expect(useUiStore.getState().sidebarOpen).toBe(true)

    useUiStore.getState().closeSidebar()
    expect(useUiStore.getState().sidebarOpen).toBe(false)

    useUiStore.getState().toggleSidebar()
    expect(useUiStore.getState().sidebarOpen).toBe(true)
  })
})
