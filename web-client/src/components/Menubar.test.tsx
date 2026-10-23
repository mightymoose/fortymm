import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Menubar } from './Menubar'

const items = ['File', 'Edit', 'View']

function item(name: string) {
  return screen.getByRole('menuitem', { name })
}

function tabIndexes() {
  return screen.getAllByRole('menuitem').map((menuitem) => menuitem.tabIndex)
}

function active() {
  return screen
    .getAllByRole('menuitem')
    .filter((menuitem) => menuitem.classList.contains('menubar-item--active'))
    .map((menuitem) => menuitem.textContent)
}

describe('Menubar', () => {
  it('renders a named menubar of menuitem buttons', () => {
    render(<Menubar label="App" items={items} />)

    expect(screen.getByRole('menubar', { name: 'App' })).toHaveClass('menubar')
    const menuitems = screen.getAllByRole('menuitem')
    expect(menuitems.map((menuitem) => menuitem.textContent)).toEqual(items)
    for (const menuitem of menuitems) {
      expect(menuitem.tagName).toBe('BUTTON')
      expect(menuitem).toHaveAttribute('type', 'button')
      expect(menuitem).toHaveClass('menubar-item')
    }
  })

  it('is one Tab stop, on the first item unless given an active one', async () => {
    const user = userEvent.setup()
    render(<Menubar label="App" items={items} />)

    expect(tabIndexes()).toEqual([0, -1, -1])
    expect(active()).toEqual([])
    await user.tab()
    expect(item('File')).toHaveFocus()
  })

  it('shows the active item until the bar takes the focus', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Menubar label="App" items={items} activeIndex={1} />
        <button type="button">After</button>
      </>,
    )
    expect(active()).toEqual(['Edit'])
    expect(tabIndexes()).toEqual([-1, 0, -1])

    await user.tab()
    expect(item('Edit')).toHaveFocus()
    expect(active()).toEqual([])

    await user.keyboard('{ArrowRight}')
    expect(active()).toEqual([])

    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    expect(active()).toEqual(['Edit'])
  })

  it('moves the focus with the arrow keys, wrapping, and Home and End', async () => {
    const user = userEvent.setup()
    render(<Menubar label="App" items={items} />)
    await user.tab()

    await user.keyboard('{ArrowRight}')
    expect(item('Edit')).toHaveFocus()
    expect(tabIndexes()).toEqual([-1, 0, -1])
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(item('View')).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(item('File')).toHaveFocus()
    await user.keyboard('{End}')
    expect(item('View')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(item('File')).toHaveFocus()
  })

  it('makes a clicked item the Tab stop', async () => {
    const user = userEvent.setup()
    render(<Menubar label="App" items={items} />)

    await user.click(item('View'))

    expect(item('View')).toHaveFocus()
    expect(tabIndexes()).toEqual([-1, -1, 0])
  })
})
