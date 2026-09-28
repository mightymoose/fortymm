import type { Page } from '@playwright/test'

/**
 * A Stripe.js double for the checkout suite (#1809).
 *
 * `@stripe/stripe-js`'s `loadStripe()` injects a real
 * `<script src="https://js.stripe.com/…">` tag and awaits its native `load`
 * event; `@stripe/react-stripe-js` then drives `window.Stripe(publishableKey)`
 * — `.elements(options).create('payment', options).mount(node)` for the
 * Payment Element, and `stripe.confirmPayment(...)` from the Pay button.
 * Nothing here reaches the real Stripe network: MSW is off for this suite
 * (`web-client/CLAUDE.md`), but Stripe.js is a THIRD PARTY the app loads
 * directly, outside the `/api/**` stub, so it needs its own interceptor.
 *
 * `react-stripe-js`'s own sanity check (`isStripe`) requires `elements`,
 * `createToken`, `createPaymentMethod` and `confirmCardPayment` to all be
 * functions before it will accept the `stripe` prop at all — so the double
 * carries harmless stubs for the three this app never calls, alongside the
 * `confirmPayment` it does.
 */

/** The URL `loadStripe()` injects a `<script>` for. A glob, not an exact
 * match: `@stripe/stripe-js` names its release train in the path
 * (`https://js.stripe.com/dahlia/stripe.js` as of 9.x) and appends a query
 * string, so pinning the exact path would break on the next dependency bump. */
export const STRIPE_SCRIPT_GLOB = 'https://js.stripe.com/**'

export interface StripeConfirmOutcome {
  error?: { type: string; code?: string; message: string }
  paymentIntent?: { status: string }
}

const DEFAULT_CONFIRM_RESULT: StripeConfirmOutcome = {
  paymentIntent: { status: 'succeeded' },
}

/** The double's own state, installed on `window` before any page script runs
 * (`page.addInitScript`) so it exists by the time the injected Stripe script
 * — served by the `page.route` stub below — reads and writes it. */
declare global {
  interface Window {
    __stripeConfirmResult?: StripeConfirmOutcome
    __stripeConfirmCalls?: unknown[]
    __stripeLoadedKeys?: string[]
    __stripeElementsOptions?: unknown
    __stripePaymentElementOptions?: unknown
  }
}

/** The injected `<script>`'s own body — a plain string, not a
 * `page.addInitScript` closure. It has to run as that tag's own body so the
 * browser fires *that tag's* native `load` event, which is the one
 * `loadStripe()` awaits; an `addInitScript` payload runs too early (before
 * the tag exists) to satisfy that. It reads and writes the `window.__stripe…`
 * fields an init script seeds beforehand — see `installStripeDouble`. */
const STRIPE_DOUBLE_SCRIPT = `
(function () {
  function makeElement(kind) {
    return {
      mount: function (target) {
        var node = document.createElement('div')
        node.setAttribute('data-testid', 'stripe-payment-element')
        node.setAttribute('data-stripe-kind', kind)
        node.textContent = 'Card details'
        target.appendChild(node)
      },
      unmount: function () {},
      on: function () {},
      off: function () {},
      once: function () {},
      update: function () {},
      destroy: function () {},
    }
  }
  window.Stripe = function (key) {
    window.__stripeLoadedKeys.push(key)
    return {
      version: 'dahlia',
      elements: function (opts) {
        window.__stripeElementsOptions = opts
        return {
          create: function (type, createOptions) {
            if (type === 'payment') window.__stripePaymentElementOptions = createOptions
            return makeElement(type)
          },
          update: function () {},
          getElement: function () { return null },
        }
      },
      createToken: function () { return Promise.resolve({}) },
      createPaymentMethod: function () { return Promise.resolve({}) },
      confirmCardPayment: function () { return Promise.resolve({}) },
      confirmPayment: function (args) {
        // Only the plain, JSON-serializable fields a spec actually reads
        // back (\`page.evaluate\` has to serialize this across the browser/
        // Node boundary): \`args.elements\` carries live functions
        // (\`create\`/\`update\`/…) that cannot cross it.
        window.__stripeConfirmCalls.push({
          redirect: args && args.redirect,
          confirmParams: {
            return_url: args && args.confirmParams && args.confirmParams.return_url,
          },
        })
        return Promise.resolve(window.__stripeConfirmResult)
      },
      _registerWrapper: function () {},
      registerAppInfo: function () {},
    }
  }
})();
`

/**
 * Install the Stripe.js double on `page`. Must be called BEFORE `page.goto()`
 * — it seeds `window.__stripe…` state via `addInitScript` (so it exists for
 * every document the page loads) and registers the `page.route` stub that
 * answers the injected `<script>` tag.
 */
export async function installStripeDouble(
  page: Page,
  options: { confirmResult?: StripeConfirmOutcome } = {},
): Promise<void> {
  await page.addInitScript((initial) => {
    window.__stripeConfirmResult = initial
    window.__stripeConfirmCalls = []
    window.__stripeLoadedKeys = []
  }, options.confirmResult ?? DEFAULT_CONFIRM_RESULT)

  await page.route(STRIPE_SCRIPT_GLOB, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: STRIPE_DOUBLE_SCRIPT,
    }),
  )
}

/** Change what the double's `confirmPayment` resolves to — the way a spec
 * drives a decline (or a redirect-required 3-D Secure result) after the card
 * form is already mounted. */
export async function setStripeConfirmResult(
  page: Page,
  result: StripeConfirmOutcome,
): Promise<void> {
  await page.evaluate((r) => {
    window.__stripeConfirmResult = r
  }, result)
}

/** Every `confirmPayment(args)` call the double recorded, in order — for
 * asserting the call COUNT (never more than one, even on a rapid double
 * click) and the `return_url` the app actually sent. */
export interface StripeConfirmCall {
  redirect?: string
  confirmParams?: { return_url?: string }
}

export async function stripeConfirmCalls(page: Page): Promise<StripeConfirmCall[]> {
  return page.evaluate(
    () => (window.__stripeConfirmCalls ?? []) as StripeConfirmCall[],
  )
}

export async function stripeConfirmCallCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__stripeConfirmCalls?.length ?? 0)
}
