import { describe, expect, it } from 'vitest'
import { LoginPage, type LoginPath } from '../../test/pages/LoginPage'

describe.each<LoginPath>(['/login1', '/login2', '/login3', '/login4'])('%s', (path) => {
  it('asks for an email address before moving on', async () => {
    const loginPage = await LoginPage.render(path)

    await loginPage.sendCode('not an email')

    expect(loginPage.emailError).toBeVisible()
    expect(loginPage.code).not.toBeInTheDocument()
  })

  it('moves to the code step and back without sending anything', async () => {
    const loginPage = await LoginPage.render(path)

    await loginPage.sendCode('ama@example.com')

    expect(loginPage.code).toBeInTheDocument()
    expect(document.body).toHaveTextContent('We sent a 6-digit code to ama@example.com')

    await loginPage.changeEmail()

    expect(loginPage.email).toBeInTheDocument()
  })
})
