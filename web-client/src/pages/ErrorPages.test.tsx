import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorPage } from '../test/pages/ErrorPage'
import { API_BASE_URL, server } from '../test/server'

function healthAnswers(response: () => Response) {
  server.use(http.get(`${API_BASE_URL}/v1/health`, response))
}

describe('error pages', () => {
  beforeEach(() => {
    // React and the router log the errors these pages show.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the not-found page, with no sidebar, for a path that matches no route', async () => {
    const page = await ErrorPage.render('/no-such-page')

    expect(page.title).toHaveTextContent('We can’t find that page')
    expect(page.sidebar).not.toBeInTheDocument()
  })

  it('goes to Home from the not-found page', async () => {
    const page = await ErrorPage.render('/no-such-page')

    await act(() => userEvent.click(page.homeLink))

    expect(await screen.findByRole('heading', { level: 1, name: 'FortyMM' })).toBeInTheDocument()
  })

  it.each([502, 503, 504])('says it can’t reach FortyMM when health answers %i', async (status) => {
    healthAnswers(() => HttpResponse.json({}, { status }))

    const page = await ErrorPage.render('/')

    expect(page.title).toHaveTextContent('Can’t reach FortyMM')
    expect(page.sidebar).not.toBeInTheDocument()
  })

  it('says it can’t reach FortyMM when health gets no response', async () => {
    healthAnswers(() => HttpResponse.error())

    const page = await ErrorPage.render('/')

    expect(page.title).toHaveTextContent('Can’t reach FortyMM')
  })

  it('says when to try again when health answers 429 with Retry-After', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 25, 19, 42, 10).getTime())
    healthAnswers(() => HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '60' } }))

    const page = await ErrorPage.render('/')

    expect(page.title).toHaveTextContent('Wait a minute, then try again')
    expect(page.text).toContain(
      `Try again at ${new Date(2026, 9, 25, 19, 43, 10).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    )
  })

  it('leaves out the time when a 429 has no Retry-After', async () => {
    healthAnswers(() => HttpResponse.json({}, { status: 429 }))

    const page = await ErrorPage.render('/')

    expect(page.title).toHaveTextContent('Wait a minute, then try again')
    expect(page.text).not.toContain('Try again at')
  })

  it('says something went wrong for any other failure', async () => {
    healthAnswers(() => HttpResponse.json({}, { status: 500 }))

    const page = await ErrorPage.render('/')

    expect(page.title).toHaveTextContent('Something went wrong')
    expect(page.homeLink).toHaveAttribute('href', '/')
  })
})
