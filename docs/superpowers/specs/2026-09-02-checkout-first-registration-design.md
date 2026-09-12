# Checkout-first registration for providers that cannot carry buyer identity

Date: 2026-09-02. Author: Aurelia. Status: approved design, awaiting implementation.

## Problem

Zeffy-owned registration flows collect the buyer's email and answers locally,
create a pending registration, then send the buyer to Zeffy where they must
enter their email again. The two emails can differ, which breaks exact-email
linking, and the buyer answers questions before they have bought anything.

Zeffy's public API is read-only and offers no way to hand identity into
checkout or get a token back: no checkout-session creation, `metadata` is
"reserved for future key-value pairs", the custom thank-you redirect is a static
URL configured by Zeffy support with no documented return parameters, and URL
prefill (`email`, `firstname`, `lastname`) is documented only for donation
forms. Payments can be listed by campaign and `created[gte]` with cursors.

## Decision

For any provider that cannot carry buyer identity into checkout, registration
is checkout-first: the buyer sees the purchase options and buys, the payment is
ingested when it appears, the ingestion emails the buyer a wallet link, and the
buyer finishes any remaining questions in the wallet. The pre-checkout form is
removed for such providers, not made optional.

## Observable behavior contract

1. `PaymentProviderCapabilities` gains `checkoutCarriesBuyerIdentity`. Zeffy is
   `false`. A flow is checkout-first when its checkout method belongs to a
   provider with the flag false AND the flow is payment-gated
   (`paymentRequired`) or a ticket flow. An optional-payment flow (Zeffy
   campaign linked, payment not required) keeps its local form, since the form
   is primary there and payment is an add-on.
2. The hosted-event flow editor hides "Collect registration information before
   checkout" for checkout-first flows and shows a note that details are
   collected after payment. Manual and invoice flows are unchanged. No data
   migration: existing Zeffy flows become checkout-first on deploy.
3. The public register page for a checkout-first flow renders the flow
   description, the read-only price preview, the list of questions the buyer
   will answer after payment (if any), and one Buy now button. It renders no
   email field and no form. Ticket-kind flows use the same Buy now path.
4. The register API rejects form submissions for checkout-first flows with the
   same 409 it already returns for ticket-kind flows.
5. Buy now creates a checkout record with no email and no answers, stores the
   opaque handle in localStorage, and opens the provider checkout URL unmodified
   in the existing popup-or-navigate manner.
6. On return, the checkout status endpoint keeps its bearer-handle auth,
   per-checkout throttle, and page cap. When the checkout has no stored email,
   the buyer-email filter is dropped: every succeeded, non-fully-refunded
   payment on the mapped campaign created within the checkout window is passed
   to the existing payment ingestion pipeline. Ingestion remains idempotent on
   the provider payment id.
7. Ingestion of a checkout-first payment always issues the wallet grant email to
   the provider buyer email. That emailed grant is the only way a guest reaches
   the registration or tickets; no page lets a visitor look up a record by email.
8. The wallet email and the return screen are status-aware. When the
   registration has unanswered required questions the copy says finish your
   registration; otherwise it says view your tickets. The wallet email leaves
   the announcements notification category so an opt-out cannot suppress it.
9. The status endpoint accepts an optional Firebase ID token. When the
   account's VERIFIED email matches the buyer email of a payment processed for
   this checkout, the response carries a freshly minted wallet path and the
   client redirects there. An unverified account email is never trusted, since
   anyone can sign up with another person's address. A mismatch falls through
   to the guest screen.
10. The guest return screen, once a payment is found, tells the buyer to check
    the email they used at checkout, with the status-aware wording from item 8.
    While polling has found nothing yet (including after the buyer cancels or
    closes checkout), the screen says: if you completed your payment, watch
    your email for next steps; if you did not, you can go back and purchase,
    with a button that reopens checkout. Zeffy emits no cancel or
    abandoned-checkout event, so this copy cannot be narrowed. When nothing is found within the
    polling window, the existing pending state and payment-inquiry rescue link
    remain.
11. Registrations gain `detailsStatus: "complete" | "incomplete"`, computed on
    write as: every required custom field in the flow snapshot has a non-empty
    answer and, for group flows, every participant has a name.
12. The wallet API returns unanswered required fields (empty values) and the
    participant list alongside existing answers. Its PATCH accepts them,
    validates with the same rules as the registration form, never touches
    email, payment, or purchased options, keeps the existing rate limit, body
    cap, and optimistic versioning, and recomputes `detailsStatus` on save.
13. The wallet page shows a "Finish your registration" block when
    `detailsStatus` is incomplete and the ordinary editable answers otherwise.
14. Event registration administration labels paid registrations with
    incomplete details "Details pending", shows purchased options and totals,
    lists the blank required fields in the detail view, and includes the rows in
    exports. No buyer reminder emails.
15. Concurrent checkouts on one campaign may ingest each other's payments; this
    is harmless because ingestion is idempotent and wallet grants go only to the
    buyer's own email. An unmapped campaign skips the sync and shows the guest
    copy. Payments arriving after the checkout expires are handled by the
    webhook or admin sync as today.
16. Existing privacy, refund, reconciliation, option-binding, and mobile-wallet
    behavior is unchanged.

## Touch points

- `web/src/lib/payments/registry.ts` capability flag.
- `web/src/lib/hosted-events/registration.ts` and `types.ts` checkout-first
  derivation and `detailsStatus`.
- `web/src/app/admin/hosted-events/[slug]/settings/settings-view.tsx` editor gating.
- `web/src/app/(public)/events/[slug]/register/register-view.tsx` purchase
  screen, return screen, signed-in redirect.
- `web/src/app/api/events/[slug]/register/handler.ts` rejection of form posts.
- `web/src/app/api/events/[slug]/register/checkout/{handler,admin}.ts` emailless
  checkout, campaign-scoped reconcile, account match.
- `web/src/lib/payments/registration-sync.ts` and
  `web/src/app/api/admin/payments/_shared/{registration-sync-store,ticket-access-delivery}.ts`
  `detailsStatus` and guaranteed wallet email.
- `web/src/app/api/tickets/[grant]/{handler,admin}.ts` and
  `web/src/app/tickets/[grant]/` wallet completion.
- `functions/src/delivery/templates/` wallet email copy and category.
- Admin registrations list and detail, exports.

## Testing

Test-first per layer: registry flag and editor gating; register handler 409;
checkout create without email; reconcile without the email filter and with the
page cap; signed-in redirect and mismatched-email fallthrough; `detailsStatus`
derivation; wallet GET and PATCH completion with validation; email category and
copy. Then `./scripts/dev-build.sh check` and `build`, and a manual walk on
alpha with a real Zeffy test purchase.
