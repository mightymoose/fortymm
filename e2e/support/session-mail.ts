import { expect, type BrowserContext, type APIRequestContext } from '@playwright/test'

/** Mailpit is the QA stack's external mail boundary; these helpers never use real inboxes. */
export async function csrfHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'csrf_token')
  return csrf ? { 'X-CSRF-Token': csrf.value } : {}
}

export async function receivedLink(request: APIRequestContext, mailpit: string, email: string, previousIds: string[] = []): Promise<string> {
  let messageId = ''
  await expect.poll(async () => {
    const response = await request.get(`${mailpit}/api/v1/search`, { params: { query: `to:${email}` } })
    const mailbox = await response.json()
    messageId = mailbox.messages?.find((message: { ID: string }) => !previousIds.includes(message.ID))?.ID ?? ''
    return messageId
  }, { timeout: 20_000, message: `A captured link should arrive for ${email}` }).not.toBe('')
  const response = await request.get(`${mailpit}/api/v1/message/${messageId}`)
  const message = await response.json()
  const link = String(message.Text).match(/https?:\/\/[^\s<>]+(?:verifying|confirm-email)\?token=[^\s<>]+/)?.[0]
  expect(link, 'The captured message must contain the actual sign-in/confirmation link').toBeTruthy()
  return link!
}

export async function requestLoginLink(context: BrowserContext, mailpit: string, email: string): Promise<string> {
  const before = await context.request.get(`${mailpit}/api/v1/search`, { params: { query: `to:${email}` } })
  const previousIds: string[] = (await before.json()).messages.map((message: { ID: string }) => message.ID)
  const response = await context.request.post('/api/v1/login/request', {
    headers: await csrfHeaders(context),
    data: { email, captcha_token: 'test-token', fmm_hp_token: '' },
  })
  expect(response.status(), await response.text()).toBe(202)
  return receivedLink(context.request, mailpit, email, previousIds)
}
