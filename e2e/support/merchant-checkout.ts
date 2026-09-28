import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { request } from '@playwright/test'

import { grantBetaTester } from './rbac-grant'

// The one seam that makes issue #1809's PAID checkout flow reachable against
// the real stack, rather than only against the unit-level `TOURNAMENT_PAYMENT_
// MERCHANT_ACCOUNT_ID` fixtures `api/tests/test_tournament_checkouts.py` sets
// per-test with `monkeypatch`.
//
// `checkout_available` (`app/tournament_serialization.py`) is true only for a
// tournament whose OWNER's Account id equals `Settings.
// tournament_payment_merchant_account_id` — and an Account id is minted
// server-side (`uuid.uuid4()`, `app/models/account.py`) the moment a guest
// session is first created. There is no id to bake into `docker-compose.e2e.yml`
// before the stack has ever booted, so this module mints one dedicated
// "merchant" guest itself, once the stack answers, and hands its id back to
// `global-setup.ts` to bake into a **recreate** of `api`+`worker`.
//
// The merchant's session is then persisted to disk (`storageState`) so the one
// spec that drives the paid flow (`tests/tournament-checkout.spec.ts`) can load
// it into its own `APIRequestContext` and seed a tournament AS that exact
// Account — the only account the recreated stack will ever offer checkout for.

/** Where the merchant guest's cookies land, so a spec can load them back with
 * `request.newContext({ storageState: MERCHANT_STORAGE_STATE_PATH })`. Lives in
 * the OS temp dir, never under `e2e/`, so a run never leaves a file for git to
 * notice — `global-teardown.ts` deletes it anyway (`clearMerchantAccountState`),
 * but a crashed run that skips teardown still leaves nothing checked in. */
export const MERCHANT_STORAGE_STATE_PATH = resolve(
  tmpdir(),
  'fortymm-e2e-merchant-storage-state.json',
)

export interface ProvisionedMerchant {
  /** The Account id the recreated `api`/`worker` must be told about — what a
   * spec's seeded tournament has to be OWNED BY for `checkoutAvailable` to be
   * true on it. */
  readonly accountId: string
  readonly username: string
}

/**
 * Mint the merchant guest, grant it `tournament.create` (the same "Beta
 * tester" role every other director-driven spec grants — see
 * `rbac-grant.ts`), and persist its session so a later spec can act as it.
 *
 * Two `GET /v1/session` calls, exactly like `support/match-api.ts`'s
 * `mintGuest` — the second stamps `last_seen_at`, which is not load-bearing
 * here (this guest is never searched for), but there is no narrower endpoint
 * and duplicating the shape only to drop a line would be its own bug to keep
 * in sync.
 */
export async function provisionMerchantAccount(
  baseURL: string,
): Promise<ProvisionedMerchant> {
  const ctx = await request.newContext({ baseURL })
  const first = await ctx.get('/api/v1/session')
  if (!first.ok()) {
    throw new Error(
      `merchant session mint failed: ${first.status()} ${await first.text()}`,
    )
  }
  const stamped = await ctx.get('/api/v1/session')
  if (!stamped.ok()) {
    throw new Error(
      `merchant session restamp failed: ${stamped.status()} ${await stamped.text()}`,
    )
  }
  const { data } = (await stamped.json()) as { data: { user: { id: string; username: string } } }

  grantBetaTester(data.user.username)

  await ctx.storageState({ path: MERCHANT_STORAGE_STATE_PATH })
  await ctx.dispose()

  return { accountId: data.user.id, username: data.user.username }
}

/** Delete the persisted merchant session, if one exists. Idempotent — safe to
 * call from `global-teardown.ts` whether or not provisioning ever ran (e.g.
 * `E2E_BASE_URL` skipped `global-setup.ts` entirely). */
export function clearMerchantAccountState(): void {
  if (existsSync(MERCHANT_STORAGE_STATE_PATH)) {
    rmSync(MERCHANT_STORAGE_STATE_PATH)
  }
}
