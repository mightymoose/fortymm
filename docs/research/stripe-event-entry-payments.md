# Stripe and Apple Pay constraints for event entry checkout

Research date: 2026-09-19. Context: [Establish Stripe and Apple Pay constraints for event entry checkout](https://github.com/mightymoose/fortymm/issues/1759), part of [Stripe event entry payments — implementation-ready specification](https://github.com/mightymoose/fortymm/issues/1758).

This is a fact-finding asset, not an implementation or product-policy decision. The agreed direction is a US account, one fee per event, the operator's single Stripe account, web and native iOS, Apple Pay, and payment securing entry with a short capacity reservation. USD and Apple Pay with card fallback are launch assumptions for confirmation in the map's product decisions. Independent organizers come later. No authenticated Stripe or Apple account was inspected and no payment was made.

## Integration options

| Option | Documented capabilities | Implication for the spec (inference) |
| --- | --- | --- |
| Stripe-hosted Checkout | Prebuilt payment page, order summary and branding settings; Checkout Sessions API. | Least application payment UI to maintain; polished surrounding registration screens can coexist with a hosted handoff. |
| Embedded Checkout | Prebuilt checkout within the website. Current docs distinguish full embedded page from an embedded form in public preview. | Keeps checkout on-site, but not unrestricted layout control; avoid silently depending on preview features. |
| Elements | Payment Element embeds payment fields; Express Checkout Element supplies wallet buttons; Appearance API provides styling. Compatible with Checkout Sessions or lower-level PaymentIntents. | More control for a bespoke event summary and checkout layout, with more application-owned behavior. |
| Native PaymentSheet | Stripe's iOS SDK offers a prebuilt native payment flow and Apple Pay configuration. | Native payment UI can share application rules with web without sharing the same presentation or necessarily the same Stripe API orchestration. |

Sources: [Checkout comparison](https://docs.stripe.com/payments/checkout), [Payment Element and compatible APIs](https://docs.stripe.com/payments/payment-element), [native payment integration](https://docs.stripe.com/payments/mobile/accept-payment?platform=ios&type=payment).

Stripe currently recommends Checkout Sessions for most web Elements integrations; PaymentIntents remain supported when owning lower-level checkout logic. The native guide describes PaymentIntent-based confirmation. Do not assume an Elements client secret, Checkout Session secret, and PaymentIntent secret are interchangeable. Exact SDK versions, stable API version and supported UI mode values remain implementation decisions: the inspected documentation includes newer UI names alongside older indexed examples. [Payment Element APIs](https://docs.stripe.com/payments/payment-element), [native integration](https://docs.stripe.com/payments/mobile/accept-payment?platform=ios&type=payment).

## Apple Pay and real-world entry eligibility

Apple's guideline 3.1.3(e) requires payment methods other than App Store in-app purchase for physical goods or services consumed outside the app, and names Apple Pay/card entry as examples. **Inference:** entry to an in-person table-tennis event fits that category; this research does not extend that conclusion to digital competitions or bundled digital entitlements, or promise an App Review outcome. [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#goods-and-services-outside-of-the-app).

US Stripe accounts can accept Apple Pay. Availability to a particular player depends on device, wallet and integration eligibility; retain a card fallback. Hosted Checkout handles Apple Pay without additional merchant-domain setup. Elements and embedded Checkout require registration of every domain/subdomain displaying Apple Pay, including testing domains. Stripe handles web merchant validation. Embedded-page Apple Pay has Safari/iOS 17+ constraints. [Stripe Apple Pay for web](https://docs.stripe.com/apple-pay?platform=web).

Native setup requires Apple Developer enrollment, an Apple Merchant ID, a payment-processing certificate obtained using Stripe's CSR workflow, and the Apple Pay capability/merchant ID in Xcode. PaymentSheet configuration adds that merchant ID and business country. A standalone Apple Pay button can instead use ApplePayContext. Determine the charge amount on the server, not from a client-supplied total. [Native Apple Pay](https://docs.stripe.com/apple-pay?platform=ios), [PaymentSheet Apple Pay setup](https://docs.stripe.com/payments/mobile/accept-payment?platform=ios&type=payment#apple-pay).

Express Checkout wallet buttons have browser/device-specific support. Their visibility is capability-dependent; a design cannot guarantee every visitor sees an Apple Pay button. [Express Checkout Element](https://docs.stripe.com/elements/express-checkout-element).

## Payment timing and capacity reservations

Checkout's scheduled `expires_at` is 30 minutes–24 hours after creation, defaulting to 24 hours. An open session can also be explicitly expired through the API; Stripe sends `checkout.session.expired`. [Limited inventory guide](https://docs.stripe.com/payments/checkout/managing-limited-inventory?locale=fr-CA). Once expired, the session cannot be completed; expiration fails if it is no longer in an expirable state. [Expire a Checkout Session](https://docs.stripe.com/api/checkout/sessions/expire).

**Inference:** a five- or ten-minute capacity hold cannot simply be expressed as Checkout's scheduled expiry. It needs application scheduling, explicit expiration, and reconciliation if payment completion races expiry. A browser countdown alone cannot release inventory safely. Hold duration, whether in-flight authentication extends it, and what happens after late success remain human decisions.

A separate PaymentIntent can be canceled only in documented cancellable states; successful payments require a refund instead. For Checkout-owned intents, expiration is the ordinary abandonment operation; the current cancellation reference documents a `requires_capture` exception. Verify the selected API version rather than assuming every `processing` payment is cancellable. [Cancel PaymentIntent](https://docs.stripe.com/api/payment_intents/cancel), [refund/cancellation lifecycle](https://docs.stripe.com/refunds).

Manual capture authorizes funds before collecting them and is supported for cards/Apple Pay. Authorization validity is finite and network-dependent; common customer-initiated online card windows are seven days. Use the payment's actual capture deadline. **Inference:** a card authorization is a different resource from an event capacity hold; adopting manual capture adds a capture failure/expiry workflow and does not settle reservation policy. [Authorization and capture](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method), [Apple Pay capabilities](https://docs.stripe.com/apple-pay?platform=web).

Checkout completion is not always payment success: delayed methods can produce later `checkout.session.async_payment_succeeded` or `checkout.session.async_payment_failed`. Check server-side payment status and fulfill once, including concurrent repeated calls; never depend solely on a return page. [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted). PaymentSheet hides delayed methods by default; when enabled, `.completed` can still mean funds are pending. [PaymentSheet delayed methods](https://docs.stripe.com/payments/mobile/accept-payment?platform=ios&type=payment).

**Inference:** selecting only immediate card/wallet methods reduces but does not eliminate uncertainty from authentication, network loss and delayed notifications. The application still needs a defined late-success path, rather than declaring a payment failed because the user closed checkout.

## Webhooks, retries and reconciliation

Stripe retries live webhook delivery for up to three days; sandbox retries run three times over a few hours. Ordering is not guaranteed and duplicate events occur. Verify `Stripe-Signature` with the raw request body and the correct endpoint secret; test/live secrets differ. Record event IDs; separate event objects may represent the same object/type change. Return a prompt successful response and defer complex processing. [Webhook delivery and verification](https://docs.stripe.com/webhooks).

POST idempotency keys retain the initial response, including server errors; reused keys must have matching parameters. Keys may be pruned after at least 24 hours. **Inference:** Stripe request idempotency does not replace durable application uniqueness for an entry, checkout attempt, fulfillment or refund. Persist operation identity and Stripe references, and reconcile unknown network outcomes before starting another charge. [Idempotent requests](https://docs.stripe.com/api/idempotent_requests).

**Architecture constraints inferred from these facts:** validate account/environment, event/entry association, currency and amount before granting entry; converge webhook and client refresh paths on one idempotent transition; make capacity allocation atomic; recover missed notifications by fetching provider state. These are candidate requirements for the architecture ticket, not an approved schema or prescribed queue technology.

## Refunds, disputes and money representation

Stripe supports full and partial refunds through API or Dashboard, capped at the original charge total. Refunds return to the original method, may remain pending if the available card-payment balance is insufficient, and can fail. Creating a refund is not proof of bank completion. Original processing fees are not returned. Track refund lifecycle events, including `refund.created`, `refund.updated` and `refund.failed`. Cancellation before capture is distinct from refunding a succeeded payment. [Refunds](https://docs.stripe.com/refunds).

A card dispute can remove the disputed amount and a dispute fee from the Stripe balance; Stripe notifies through Dashboard/email/webhooks/API, and the issuer decides the outcome. Apple Pay supports disputes and refunds too. **Inference:** entry cancellation, refund state and dispute state should not be collapsed into one paid/unpaid flag. Eligibility for refunds, fee absorption, operator authority and response procedures remain product decisions. [Dispute lifecycle](https://docs.stripe.com/disputes/how-disputes-work), [Apple Pay capabilities](https://docs.stripe.com/apple-pay?platform=web).

Amounts use currency minor units; USD uses integer cents and ordinarily has a $0.50 minimum charge. **Inference:** paid fee validation must reject subminimum totals or specify their handling. A free entry is a separate application path, not a zero-dollar card charge. If currency localization is enabled later, revisit presentment/settlement rules; US/USD scope does not itself configure Stripe's optional currency features. [Currencies and minimum amounts](https://docs.stripe.com/currencies).

## Testing and account-dependent checks

Stripe test environments simulate transactions without moving money. Test cards cover failures/authentication scenarios but cannot prove real settlement, payout readiness or live account approval. Apple Pay tests use a real card in the wallet with Stripe test keys; Stripe says its test card numbers and Apple sandbox test cards cannot be added for this Stripe wallet-testing flow. [Testing](https://docs.stripe.com/testing), [Apple Pay test instructions](https://docs.stripe.com/apple-pay?platform=web#test-apple-pay).

Proposed acceptance scenarios (not executed): card and Apple Pay success on both surfaces; unsupported wallet fallback; authentication interruption; double submit; app kill after payment; two players competing for the final place; payment racing expiry; webhook duplicate/reordering/outage; retry after uncertain charge creation; refund pending/failure; operator refund in Dashboard; and test/live isolation. Short-hold expiry behavior needs an actual integration test once an API version is pinned.

Not verified: Stripe activation, enabled methods, live fees, payout/bank settings, business eligibility, domains, merchant certificate/expiry, entitlements and signed-device behavior. Inspect those through authorized accounts during implementation; no secrets are needed in issues. This investigation also does not decide tax obligations, refund terms or surcharge policy.

## Later independent organizers

Connect supports payments among platforms and connected accounts, with organizer onboarding and verification. [Connect overview](https://docs.stripe.com/connect). Direct charges belong to a connected account; destination charges collect on the platform and transfer onward; separate charges/transfers decouple collection from distribution. The choice changes whose balance bears refunds/disputes and which business details appear. [Connect charge types](https://docs.stripe.com/connect/charges).

**Inference:** collecting solely for the operator's own events does not itself require Connect. Preserve the payment recipient/account context and Stripe object ownership in the design, but do not add organizer onboarding or select a future charge type now. Later extension requires a new decision about commercial roles, onboarding, fees and liabilities; it is not merely replacing one API key or moving historical payments between accounts.
