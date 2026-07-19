import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@/test/utilities'
import { PERM } from '@/lib/permissions'
import { apiTokensPageObject } from './api-tokens-page.page'

describe('ApiTokensPage gate', () => {
  it('lets a user with api_token.manage mint a token and reveals it once with the password caution', async () => {
    const token = 'fmm_test_raw_token_abcdef123456'
    apiTokensPageObject.signInWithPermissions([PERM.API_TOKEN_MANAGE])
    apiTokensPageObject.stubGeneratedToken(token)
    apiTokensPageObject.render()

    const generate = await screen.findByRole('button', {
      name: /generate token/i,
    })
    expect(apiTokensPageObject.queryNoPermission()).not.toBeInTheDocument()

    // No token before the click — the reveal is a response to the mutation.
    expect(apiTokensPageObject.queryToken(token)).not.toBeInTheDocument()

    await userEvent.click(generate)

    // The returned raw token renders once, behind the "won't be shown again"
    // caution — and only because the click actually hit POST /v1/api-tokens.
    expect(await screen.findByText(token)).toBeInTheDocument()
    expect(apiTokensPageObject.queryPasswordCaution()).toBeInTheDocument()
    await waitFor(() =>
      expect(apiTokensPageObject.createCallCount()).toBe(1),
    )
  })

  it('hides the Generate control from a user without api_token.manage', async () => {
    apiTokensPageObject.signInWithPermissions([])
    apiTokensPageObject.render()

    // The shared AccessDenied panel is the ungated state's tell; wait for it so
    // the session has resolved before asserting the control's absence.
    expect(
      await screen.findByText(
        'Ask an administrator to grant you access to this page.',
      ),
    ).toBeInTheDocument()
    expect(apiTokensPageObject.queryGenerateButton()).not.toBeInTheDocument()
  })
})
