<!--
Copyright (c) 2026 Band Boosters Platforms. Use of this file is governed by
the LICENSE file in the repository root.

Defines the authoritative hosted-event registration-flow architecture, including
flow-owned fields and exact provider-option bindings, form-backed external
checkout, anonymous same-browser resume, provider-authoritative purchase
projection, exact-email payment reconciliation, staff-assisted matching, ticket
issuance and access, immutable snapshots and exports, secure email-based access,
and legacy compatibility.
-->

# Hosted-event registration flows

- **Date:** 2026-09-01
- **Orch tasks:** `PzhRWPdLoh-XwvHhUvDb3`, `cijK27jdePZoMg_wFOtQn`,
  `Q7zh4ENR0hjn1KVYAzf0N`, `bjj1NJy3C-eboahQVTq2h`,
  `UbVaWCccPAfj2pG1r_m5p`, `zlKsrA2Ob415F4HVhabbN`
- **Status:** Resumable checkout, assisted reconciliation, ticket access,
  purchaser response editing, and refund requests implemented in integration

The Zeffy setup, payment-gating, and payment-confirmation extension is tracked
by Orch task `eDTohSBKbtdIj47933kk7` and is implemented in the flow editor,
public submission route, provider-payment projection, and registration lookup.

Related documentation:

- [Hosted-event requirements](RequirementsGathering/08-requirements-hosted-events.md)
- [Payment-provider and Zeffy design](../superpowers/specs/2026-07-24-payment-provider-zeffy-design.md)
- [Signed-in hosted-event contextual actions](../Development/hosted-event-context-actions.md)
- [Registration-flow operator guide](../Development/hosted-event-registration-flow-operations.md)

## Context

A hosted event can serve more than one audience in the same year. Drumline
Festival, for example, needs an invoiced school/group registration and a
spectator ticket purchase. A concert may need an attendee ticket checkout and a
separate vendor registration. Treating the parent event as either
`registration` or `ticketed` makes those combinations impossible and forces
unrelated concerns into one switch.

Each hosted-event year therefore owns an ordered `registrationFlows` list.
Every flow is one public entry point with its own reusable fields, prices,
submission outcome, checkout provider, availability, discoverability, and
recovery-action visibility. The submitted contact email remains the event-wide
recovery identity: flow settings decide where and how the action is shown, not
which matching registrations the lookup may return.

This design supersedes the singular registration-versus-ticket assumption in
the original hosted-event requirements and the year-wide provider link in the
initial payment-provider design. Existing records remain supported through the
compatibility rules below.

## Separation of concerns

The settings are intentionally independent:

| Concern | Configuration | Effect |
| --- | --- | --- |
| Mechanics | `kind: group | standard | tickets` | Selects local group/standard submission or ticket-checkout behavior. It is not a registrant classification. |
| Form schema | Reusable buyer- and participant-scoped `fields` | Defines what a group or standard flow collects. Ticket flows have no registration fields. |
| Pricing | Ordered `prices`, `showPricingOnPublicPage`, and `pricingDescription` | Applies the effective local registration price or presents ticket purchase/display options. |
| Availability | Enabled state | Determines whether the direct flow URL can be used. |
| Discoverability | Public-event-page visibility | Determines whether the public event page advertises an enabled flow. |
| Local outcome | `invoice` or `confirmation` | Determines whether a successful group or standard submission creates an invoice. |
| Payment gate | Required or not required | Determines whether a group or standard submission is pending until provider payment. It is not inferred from form kind or invoice outcome. |
| Payment campaign | Per-flow Zeffy mapping | Routes a completed provider payment to one hosted-event flow. |
| Ticket checkout | `manual` or connected-provider checkout | Selects a configured external URL or a mapped Zeffy campaign. |
| Recovery discovery | Per-flow `showRecovery` | Shows “Check your registration” for group/standard or “View your tickets” for tickets while retaining one event-wide email lookup. |

This separation permits an enabled but unlisted invitation link, a public
confirmation-only form, a payment-gated vendor form, or an invoiced group form
and ticket checkout on the same event. Existing invoice and confirmation flows
do not become payment-gated merely because Zeffy is connected or a campaign is
available. Hiding a flow never disables it. Disabling a flow makes its direct
URL unavailable even if an old link has been shared.

## Per-year flow model

Each current flow has:

- a stable flow identity and direct-link slug;
- a public label, used for the call to action and flow heading;
- one kind: `group`, `standard`, or `tickets`;
- an enabled state;
- an independent “show on public event page” state;
- per-flow recovery and pricing visibility; and
- kind-specific outcome and checkout configuration.

Current flows do not store or render `registrantType`. `kind` controls mechanics
only; the reusable field definitions describe whether a form collects school,
ensemble, student, vendor, or other data. Current Admin saves write this
canonical shape:

```text
group | standard:
  { id, slug, label, kind, enabled, showOnPublicPage, showRecovery,
    fields: [{ key, label, scope: "buyer" | "participant", type,
               required, options, allowOther? }],
    prices: [{ id, label, amountCents, unit, description,
               startsOn?, endsOn?, purchaseUrl?, allowMultiple }],
    showPricingOnPublicPage, pricingDescription,
    outcome: "invoice" | "confirmation", paymentRequired: boolean,
    checkout?: {
      method: "zeffy", campaignId, url, manualFallbackUrl
    } }
tickets:
  { id, slug, label, kind, enabled, showOnPublicPage, showRecovery,
    prices: [{ id, label, amountCents, unit, description,
               startsOn?, endsOn?, purchaseUrl?, allowMultiple }],
    showPricingOnPublicPage, pricingDescription,
    checkout: { method: "manual", url }
      | { method: "zeffy", campaignId, url, manualFallbackUrl } }
```

Compatibility readers also accept the earlier aliases `registrationFields`,
`ticketCheckout`, `manualCheckoutUrl`, `zeffyCampaignId`, and
`zeffyCheckoutUrl`, plus the earlier nested flow-pricing shape. Admin saves
persist the canonical shape and omit current-flow `registrantType`. Runtime
normalization keeps old records usable; new code must not introduce another
parallel representation.

List order is display order. The canonical direct URL is:

```text
/events/:eventSlug/register/:flowSlug
```

The event slug identifies the hosted event, which resolves its current year;
the flow slug identifies one flow in that year. Administrators copy this stable
URL from the event settings page. Changing a label, visibility, billing mode,
or provider must not change the URL.

### Group flow

A `group` flow is the group-registration mechanism for bands, schools,
ensembles, drumlines, and other organizations. It accepts anonymous submissions;
an account is not required. Its buyer- and participant-scoped `fields` decide
which organization, ensemble, director, phone, billing, participant, or other
answers are shown and required. Contact email remains required as the recovery
identity. A current group flow never consults the legacy year-wide
`registrationType`.

### Standard flow

A `standard` flow is the local-registration mechanism for individuals, vendors,
students, or other contacts. It uses the same buyer- and participant-scoped
field definitions as a group flow, so its configured schema—not a registrant
enum—decides what is collected and required. It also accepts anonymous
submissions, with contact email retained as the recovery identity.

### Tickets flow

A `tickets` flow sends the buyer to an external checkout. It does not reuse the
group/standard registration fields or require a Band Boosters account. Checkout
is either:

- `manual`: a configured external checkout URL; or
- `zeffy`: a selected campaign from the site's connected Zeffy integration.

Only a connected Zeffy integration is offered as a provider binding. A
disconnected integration is not shown as an available campaign source. Manual
checkout remains a first-class option for sites without Zeffy and for events
whose campaign has not yet been selected. An existing Zeffy-bound flow remains
identifiable when the integration is later disconnected, but the editor shows
that binding as unavailable instead of offering it as a new selection. Runtime
checkout uses the captured campaign URL when present and otherwise uses the
retained manual fallback.

## One flow-owned pricing collection

Every flow owns one ordered `prices` array. Each price has a stable `id`, public
`label`, integer `amountCents`, human-facing `unit`, nullable `description`,
optional inclusive `startsOn`/`endsOn` dates, and an optional absolute
`purchaseUrl`. A Zeffy-backed price may additionally retain one exact Zeffy
checkout-option ID in the compatibility-named `zeffyRateId` field. Within one
flow, the same non-empty Zeffy option ID cannot be bound to two local prices. The
provider-neutral `allowMultiple` capability
records whether a future capable checkout may sell more than one unit; it does
not make Zeffy support local quantity selection. `pricingDescription` provides
flow-level context, and `showPricingOnPublicPage` controls whether the public
event page advertises the rows. A hidden price collection remains available on
the enabled direct flow page.

The direct registration page renders every configured price in document order;
it does not collapse concurrent rows to one “effective” price. Inclusive start
and end dates are evaluated against the configured organization IANA time zone,
not against the UTC day. For example, at `2026-09-01T06:30:00Z`, an organization
using `America/Los_Angeles` is still on `2026-08-31`. Future and expired rows stay
visible with their availability message. Direct external rows retain their safe
whole-card interaction and URL availability rules.

A Zeffy-backed group or standard form does not present local price, ticket-type,
or quantity controls. Its currently available rows appear in configured order
under the visibly labelled **Available at checkout** read-only summary, with
each row's name and formatted price. The page explains that the buyer selects
ticket type and quantity on the secure Zeffy page. Changing registration answers
does not submit, open Zeffy, or make an unrelated request.

This constraint comes from the provider boundary: Zeffy's current public API
can read campaign rates but provides no hosted online checkout/session endpoint
that can prefill a selected rate or quantity. Every mapped rate therefore shares
the campaign checkout URL. Pretending a local selection would carry into Zeffy
would be misleading, so the provider checkout—not local browser state—is the
authority for what the buyer selects and pays. `allowMultiple` remains a future-
provider capability and has no effect on the current Zeffy handoff.

The local price label and amount describe configuration; they are not matching
keys. Saving preserves the exact selected Zeffy option ID, and neither saving nor
payment ingestion creates or repairs a binding because a remote label or amount
looks similar. This makes a stale or intentionally unbound row visible instead
of silently changing its meaning.

The form has one final submit action. If another required answer is missing, it
makes no request and announces the accessible field error beside that control.
A valid action sends the completed registration answers exactly once, without a
local Zeffy price or quantity intent. The server resolves the exact flow and its
mapped Zeffy checkout URL; the browser must not derive the destination from
hard-coded event or price data. Saving the local submission does not open Zeffy.
It replaces the form with a confirmation of the submitted answers, prominently
repeats the exact linking email, explains that the buyer must enter that same
address at Zeffy, and presents one **Pay now** action.

## Checkout-first purchase and return

Zeffy cannot carry buyer identity into checkout: its public API is read-only,
its `metadata` field is reserved, its custom thank-you redirect is a static URL
configured by support, and URL prefill is documented only for donation forms.
The provider registry therefore declares `checkoutCarriesBuyerIdentity: false`
for Zeffy, and `isCheckoutFirstFlow` treats every payment-gated group/standard
flow and every ticket flow mapped to Zeffy as **checkout-first**: the buyer pays
first, ingestion creates the registration, and required details are finished in
the emailed wallet. This removes the double email entry that broke exact-email
linking. Optional-payment flows (campaign mapped, payment not required) keep the
local form described under the optional payment gate.

### Purchase handoff

The register page renders no form for a checkout-first flow. It shows the flow
description, the read-only price preview, the required questions the buyer will
be asked after payment, and one **Buy now** action. The register API rejects
form submissions for such flows with the same 409 it returns for ticket flows.
**Buy now** calls `POST /api/events/{slug}/register/{flow}/checkout`, which
issues an opaque, expiring checkout capability carrying only the event, flow,
campaign, and issue time (no email, no answers), and returns it with the
server-resolved Zeffy URL. The browser saves only the handle, its expiry, and
the return route, then opens Zeffy in a popup on desktop (falling back to the
current tab) or the current tab on phones.

### Waiting and paid states

Until a payment is ingested the return route shows **Waiting for your payment**
with the copy "If you completed your payment, watch your email for next steps.
If you didn't, you can go back and purchase.", plus **Buy again** and **Check
payment status**. Zeffy emits no cancel or abandoned-checkout event, so this copy
cannot be narrowed. Once a payment is ingested the page shows **Payment
received** and tells the buyer to check the email they used at checkout for a
link to finish their registration when the flow has required questions, or to
view their tickets otherwise. The emailed wallet grant is the only way a guest
reaches the record; no page looks a registration up by email, which keeps the
enumeration boundary intact.

When the visitor is signed in, the status poll also carries their Firebase ID
token in `X-Viewer-Token`. If that account's **verified** email equals the buyer
email of a payment ingested for this checkout, the server mints a sibling
wallet grant (the emailed raw grant is never stored, only its digest) and the
page redirects straight to `/tickets/<grant>`. An unverified account email is
never trusted, because anyone can sign up with another person's address.

### Opaque resume authority

The resume handle is a bearer capability with a narrow boundary. It authorizes
status and resume behavior only for the exact hosted event, event year, flow,
and route for which it was issued, and it expires. Invalid, expired, altered, or
cross-event use returns one uniform data-free result. Status requests carry the
raw handle only as an authorization bearer credential; server persistence is
keyed by its purpose-separated digest. On return the server reconciles the exact
mapped campaign for payments created inside the checkout window, once per
minute and at most three pages, passing every succeeded non-refunded payment
through the same idempotent ingestion pipeline the webhook uses and recording
the ingested payments on the checkout for the signed-in redirect.

### Wallet completion

Registrations carry `detailsStatus`, derived on every write by running the
registration validator over the immutable flow snapshot, the stored answers,
participant rows, and purchaser wallet overrides. The wallet API returns
unanswered required questions with blank values, the participant schema, and
the participant rows; its PATCH completes an answer or replaces the participant
rows wholesale after validation, keeping the rate limit, body cap, optimistic
versioning, and audit trail, and recomputing `detailsStatus`. The wallet page
leads with **Finish your registration** while details are pending and lists
blank required answers first. Event administration labels such rows **Details
pending** and lists what is still needed; paid rows export regardless.

## Payment gate: checkout-first and optional-payment flows

A group or standard flow may explicitly require a completed provider payment
before the platform treats its submission as registered. The gate is configured
per flow. Enabling it on a Zeffy-mapped flow makes the flow checkout-first (see
above): no local submission is accepted, and the first ingested payment on the
mapped campaign creates the registration itself.

Ingesting a checkout-first payment:

1. builds the registration draft from the provider payment (buyer contact,
   one participant per ticket line, mapped `event.*` answers);
2. finds no pending local submission for the flow, confirms the flow is
   checkout-first, and creates `event_registrations/<providerPaymentId>` with
   `paymentStatus: "paid"`, the real flow kind, the immutable flow snapshot,
   `normalizedContactEmail`, exact purchased option groups, the allocated
   invoice, and `detailsStatus` derived from the snapshot;
3. enqueues one buyer confirmation and one transactional wallet email (no
   opt-out category) whose copy asks the buyer to finish their registration when
   `detailsStatus` is `"incomplete"`; and
4. on replay, refreshes provider-owned fields on the same document and resends
   nothing.

Legacy pending submissions written before this design still activate through
exact normalized-email association, so an in-flight checkout at deploy time is
not stranded.

Optional-payment flows (campaign mapped, payment not required) keep the local
form and the original association contract: a payment activates exactly one
eligible submission whose normalized contact email equals the provider buyer
email, a distinct later payment appends to `providerPaymentIds`, retries are
no-ops, and a payment with no unique same-email submission fails closed for the
reconciliation workflow rather than fabricating a registration. Name
similarity, email similarity, amount, receipt identity, or possession of a
checkout handle can never raise a non-exact match into automatic association.

Ticket purchase flows remain the source record for their registrations and use
the same Buy now path.

## Local submission outcomes

Every `group` and `standard` flow independently chooses `invoice` or
`confirmation`.

The outcome and payment gate remain independent. Enabling **Require payment
before registration** always stores the registration as pending and returns the
mapped checkout. Because Zeffy owns the buyer's option and amount, the pending
save does not create or email a local invoice based on a configured-price guess:

- a payment-required Zeffy `invoice` flow records the intended outcome, but any
  resulting paid internal invoice is created from the associated provider
  payment's identity and authoritative total after checkout; and
- a payment-required `confirmation` flow allocates no invoice and sends no
  premature free-registration confirmation. Its first confirmation is the
  provider-payment confirmation sent after activation.

The pending registration persists this outcome. Payment association consults
that saved value, so a later edit to the live flow cannot convert an already
submitted `confirmation` registration into an invoice or discard the invoice
intent of an already submitted `invoice` registration.

An immediate manual or non-Zeffy `invoice` submission preserves the existing
two-step behavior: it stores the registration, allocates the event's numbered
invoice, stores that invoice identity on the registration, stores the invoice,
and sends the established payment instructions. Existing event-code/year
numbering and purchase-order, printed-check, and configured card-payment
instructions continue to apply. A Zeffy-owned pending submission does not enter
that path before checkout. Manual/check reconciliation continues to use the
established invoice state.

A `confirmation` submission stores the registration and sends a confirmation
without creating an invoice or requiring billing-address fields. This supports
free registrations and cases where payment is handled separately. Billing
choice belongs to the flow, not the flow kind: either a group or an individual
registration may be free or invoiced.

Invoice payer details come from the configured buyer fields when present, with
the contact email as the final identity fallback. Group and standard flows do
not gain hidden organization, contact-name, phone, or billing requirements from
their kind; administrators must mark the required reusable fields explicitly.

Administrators manage reusable questions inside each group or standard flow. A
question has a stable key, label, buyer-or-participant scope, answer type,
required state, and select options where applicable. A single-select question
may set `allowOther` to accept a custom value. Adding, editing, or removing a
flow question does not modify the legacy year-wide question list.

### Structured Name questions

A custom question may use the **Name** type (stored as `type: "name"`). One configured question renders two
separately labelled inputs, **First name** and **Last name**, and stores the
answer as a structured pair rather than flattening it into display text. A
required Name answer rejects either missing half. An optional Name answer accepts
both halves blank, but rejects a partial answer because an unexplained half-name
is neither absent nor complete.

The pair stays structured in registration details, CSV export, immutable flow
snapshots, saved-checkout confirmation, reconciliation suggestions, and the
verified ticket wallet. Display layers may format the two parts together, but
must not lose either part or make ordering-dependent string parsing the source
of truth. Existing registrations whose historical answer is a string remain
readable. Reading or displaying that legacy value must not destructively rewrite
it into a guessed first/last pair.

## Zeffy campaign mapping, checkout, and payment projection

When Zeffy is connected for the site, every hosted-event flow can open a
dedicated campaign-mapping experience and contextual setup help. The mapping
experience lists the connected account's campaigns, identifies the current
selection, refreshes the remote catalog, and updates the flow without requiring
an administrator to copy an identifier. **Save mapping** immediately awaits the
hosted-event settings persistence, atomically reconciles the campaign target,
and closes the dialog only after success. A disconnected site instead explains
that Zeffy must be connected first; it does not present a mapping control that
appears usable.

Before mapping, the primary action says **Map Zeffy campaign**. After mapping,
that action is replaced by the campaign title as a safe external link to the
campaign in Zeffy, with an adjacent accessible edit-icon button that reopens the
mapping experience. The link prefers the current catalog URL and falls back to
the persisted canonical campaign checkout URL, so an existing mapping remains
navigable during a disconnection or catalog-fetch failure. The compact help
control is icon-only but has an accessible name: it shows `?` when the connection
and webhook are ready and a warning icon when either needs attention. Text in the
dialog remains the authoritative readiness explanation; color or icon shape is
never the only signal.

Zeffy's campaign API is read-only. Campaign creation therefore happens in
Zeffy, not in Band Boosters. The help experience opens Zeffy's campaign or setup
page in a new tab, preserves the local editing context, and gives the
administrator a return-refresh-map path after the campaign exists. Similarly,
Zeffy webhook configuration is a manual account operation. The help experience
may guide and validate that work, but it must not claim the platform created the
campaign or installed the callback remotely.

The campaign catalog uses a lightweight list response. Once a user maps or
edits one campaign, the platform loads detail for that authorized campaign only
and normalizes its ordered `rates`. A secret-free rate summary includes the
remote id, title, description, amount, currency, pay-what-you-can facts, and
early-close date. Campaign list responses that omit `rates` remain valid; the
editor simply has no remote rates to offer until detail is available.

For a mapped flow, each price row labels its provider selector **Zeffy checkout
option**. The control lists the mapped campaign's options and visibly identifies
whether the local row is bound, unbound, or bound to a stale option that is no
longer present in the refreshed campaign detail. Selecting an option persists
its exact remote ID and uses the campaign's shared checkout URL. Clearing the
selection leaves the row explicitly unbound; it does not use a custom URL,
label, or amount similarity as a substitute identity. A save rejects reuse of
one non-empty Zeffy option ID by two local rows in the same flow. The editor also
persists `allowMultiple`, labelled **Allow multiple (supported providers
only)**, as provider-neutral future capability metadata.

Zeffy's current public API provides neither distinct checkout URLs per rate nor
a hosted online checkout/session endpoint that can prefill rate and quantity.
Mapped Zeffy rates therefore support accurate local preview and configuration,
but they do not record buyer intent or alter the shared campaign URL. The buyer
chooses type and quantity on Zeffy, and the provider-reported completed payment
is authoritative. `allowMultiple` is intentionally inert for Zeffy until a
provider can honor that capability.

### Exact option projection and purchase history

After association, provider line items—not the flow's price list—state what the
buyer purchased. The Zeffy adapter copies each provider `rate_id` into the
provider-neutral `providerOptionId`; older normalized rows may still supply the
same identity as `rateId`. Each line item resolves a local option only when that
identity exactly equals the local row's snapshotted `zeffyRateId`. Missing IDs,
IDs absent from the saved bindings, and stale or unbound IDs remain explicitly
unmapped. Labels and amounts are display data only and never choose a local
option by similarity.

Resolved items with the same exact option ID are grouped for the purchase
summary: quantity is the number of provider items and subtotal is the sum of
their provider-reported amounts. A bound zero-dollar option is therefore known
`$0.00`; unknown and zero are distinct states. The authoritative payment total
comes from the provider payment itself and is displayed alongside the resolved
groups. A paid registration row and detail view label this data **Purchased
option(s)** and do not render every configured local price as if it were bought.

Association and projection share one result whether initiated automatically by
an exact-email match or explicitly confirmed by authorized staff. The payment
identity, exact option groups, unmapped items, gross total, refunded total, and
net total are recorded together. Both paths use the same per-payment upsert and
distinct-payment aggregate. If the flow's outcome produces an internal paid
invoice, its payment identity and money fields come from that provider result,
never from the pre-checkout local price configuration.

Purchase history is additive and idempotent. Replaying one provider payment
does not duplicate its identity, option groups, subtotals, tickets, invoice, or
confirmation. Replay refreshes that payment's authoritative `totalCents`,
`refundedCents`, and `netCents`, then recomputes registration aggregates, but it
preserves the first persisted exact-option resolution even if an administrator
later changes the live flow's bindings. A later distinct payment for the same
registration appends its identity, quantities, subtotals, unmapped items, and
money fields without replacing the earlier purchase.

The stored projection keeps the per-payment evidence and its aggregate separate:

```text
providerPurchases: [{
  providerPaymentId,
  totalCents,
  refundedCents?,
  netCents?,
  options: [{ providerOptionId, localPriceId, label?, providerLabel?,
              quantity, subtotalCents, mappingStatus: "mapped" | "unmapped",
              providerItemIds? }]
}]
purchasedOptions: [/* additive groups used by roster/detail/export */]
providerTotalCents: /* sum of distinct gross totalCents values */
providerRefundedTotalCents: /* sum of distinct refundedCents values */
providerNetTotalCents: /* sum of distinct netCents values */
```

`providerPurchases` is the idempotency and audit boundary. `purchasedOptions`
and the three `provider*TotalCents` fields are derived additive projections for
administration, invoice updates, and export. Older snapshots without the newer
optional money fields contribute zero refunded cents and derive net as gross
minus refunded. A persisted numeric zero is authoritative and must not fall
through to an unknown-state fallback.

The webhook is site/provider-level, whereas campaign mapping is per flow. A
single configured Zeffy callback can receive payments for many campaigns; the
campaign mapping routes each authenticated payment to its intended flow. The
help experience reports four distinct readiness signals:

| Signal | Ready means | It does not prove |
| --- | --- | --- |
| Connection | The site has usable Zeffy credentials and can read the remote campaign catalog. | That a flow has a campaign or that callbacks work. |
| Campaign mapping | This flow has one persisted campaign binding from the connected account. | That Zeffy has sent a payment callback. |
| Webhook secret | A webhook-token hash exists in provider settings. Immediately after generation or rotation, the tutorial can display the exact token-bearing callback URL. | That the URL was copied correctly into Zeffy, or that the one-time token can be recovered later. |
| Last accepted webhook | The platform authenticated, re-fetched, and processed a completed payment callback at the displayed time. | That every historic payment was delivered or that a particular test purchase exists. |

Secret generation is one-time sensitive setup. The webhook setup steps and
**Generate webhook secret** control appear only while no webhook secret is
configured, and only to the primary administrator identified by the legacy admin
claim. An authorized event editor who is not the primary administrator receives
an alert asking them to have the administrator finish Zeffy webhook setup; that
editor never receives secret-generation or rotation controls here. Once a
secret is configured, the completed setup steps and generation control are
hidden for everyone rather than repeatedly asking users to perform completed
setup. If the primary administrator generated the secret in the currently open
dialog, its one-time token-bearing callback remains visible until the dialog is
closed so it can actually be copied.

Generating the secret returns the token once and renders the usable
`/api/payments/webhook/zeffy?token=…` URL for copying into Zeffy's Integrations
settings. Only the hash remains after reload. Configured and delivered are
separate states: the presence of a stored secret must never be presented as
proof that Zeffy has called it, and a configured state must never appear beside
text that says the secret is missing. A configured callback with no accepted
event yet may still produce a warning readiness state, but it does not expose
the completed setup steps again.

When Zeffy checkout is selected, the flow sends buyers to the selected
campaign's checkout URL, or to a retained manual fallback when the provider URL
is not usable. The binding includes the hosted-event year and stable flow
identity so one event's simultaneous ticket, group, and standard paths cannot
be confused.

A Zeffy campaign may have other target kinds, but it may own at most one
hosted-event flow globally. The settings save reconciles the hosted-event year
and `campaign_links` in one Firestore transaction. It rejects duplicate flow
bindings and a campaign already owned by another event/year. Rebinding within
the same event year replaces the prior flow. Removing or changing the binding
removes that hosted-event target while preserving unrelated targets, writes the
canonical `targets` list, and deletes the legacy singular `target` field so an
old association cannot reappear after unbinding.

The canonical hosted-event campaign target records `registrationFlowId`,
`registrationFlowSlug`, and `registrationFlowKind` with the event slug/year.
The kind lets ingestion activate a prior group/standard submission without
materializing tickets, while a ticket target retains direct payment projection.
Generic campaign-link edits preserve all three properties. Group and standard
flows also preserve an optional Zeffy `checkout` mapping when `paymentRequired`
is false, so an administrator can prepare or retain a campaign without changing
the registration lifecycle.

Provider ingestion continues to use the existing payment pipeline:

1. Webhook or scheduled/manual sync stages the provider payment idempotently by
   provider and payment ID.
2. Before match confidence is evaluated, the campaign binding resolves the
   hosted-event flow. Ticket flows project a payment-backed registration and
   tickets. Payment-gated group and standard flows activate only an existing
   same-email pending submission; they never synthesize one from payment data.
3. Every provider line item is retained for reconciliation and purchase
   explanation. Exact option IDs enrich known local labels and grouped purchase
   summaries; missing, stale, and unbound IDs stay unmapped.
4. Ticket line items materialize platform ticket entitlements associated with
   the correct hosted-event slug, year, flow, provider, payment, and provider
   item identity. Distinct provider ticket items remain distinct tickets even
   when they share one bound option.
5. Deterministic registration/ticket document IDs and provider-payment guards
   prevent duplicate activation, ticket creation, and confirmation delivery.
   Transactional ticket upsert preserves an existing check-in code and account
   or family ownership when the same payment is processed again. Provider
   registration and invoice creation allocate a number only once in one
   Firestore transaction.
6. For local group/standard submissions, exact unambiguous flow/email matching
   preserves the first provider payment as the compatibility identity and
   appends each distinct payment to the additive identity list. Re-delivery of
   one payment remains idempotent; a separate later payment is not discarded.
7. Full-refund synchronization projects tickets as refunded, routes committed
   money through the existing reversal path, and revokes tickets by both
   provider and payment ID so cross-provider ID collisions cannot affect them.

The manual checkout mode only controls the outbound link. The platform cannot
claim provider-backed synchronization for an arbitrary URL unless that checkout
also enters through a configured integration.

Provider-created invoice money fields are refund-aware on first projection and
every replay. Gross amount records the provider charge, refunded amount records
what came back, and invoice amount records the net the boosters still hold. A
full refund changes invoice status from `paid` to `refunded`; a later refund
refresh must not leave the earlier gross total represented as current revenue.

### Buyer confirmation after payment

The first successful activation or ticket projection for a provider payment
enqueues one confirmation to the normalized buyer/contact email. The message
names the event and flow, includes organization/group when present, participant
or ticket count, net payment amount, and the secure check-registration link,
whose payment-confirmation token expires after 30 minutes. The encrypted token
binds the Firestore hosted-event document id, while the browser-facing URL uses
the canonical public slug. Its deterministic outbox identity is derived from
the staged provider payment id. The outbox operation therefore shares the provider-payment
idempotency boundary: webhook retries, manual sync after a webhook, and repeated
provider delivery do not enqueue another purchase confirmation for the same
successful payment projection.

The email is evidence of the platform's completed projection, not merely of an
incoming webhook. An unmatched group/standard payment does not send a message
claiming that registration is complete. Existing invoice mail and free-flow
confirmation behavior remain unchanged when the payment gate is not enabled.

## Assisted reconciliation and alternate-email verification

The event administration registrations workspace at
`/admin/hosted-events/:eventSlug/registrations` is the single operational
surface for the mixed lifecycle. It exposes completed submissions, pending
submissions, unlinked Zeffy entries with ranked suggestions, verified
payment-link inquiries, and refund requests. Administrators reach it through a
direct action in the event's existing cog menu rather than through a separate
unrelated subsystem. Reading provider data or performing a reconciliation
mutation requires both the established hosted-event authority and the existing
payment-management authority.

Before staff associates an unlinked payment, the workspace shows the provider's
authoritative total and line items, distinguishing items that map by exact
provider option ID from those that remain unmapped. This preview lets staff
verify the purchase contents without relaxing the existing campaign/event scope
or exact-email rule. Confirming an association does not turn a similar label or
amount into a binding.

A generic unlinked-payment preview resolves those line items against the current
prices of the campaign's mapped flow because staff has not selected a historical
registration yet. Confirmation then recomputes the purchase against the selected
registration's immutable `flowSnapshot.prices` and persists that result. The two
views may therefore differ after a legitimate binding change: current-flow
preview explains today's configuration, while the confirmed snapshot preserves
the option meaning in force for that registration.

Suggestions help staff find likely mistakes without weakening the automatic
rule. Within the same event scope, a one-character email difference can rank a
registration as likely, and an exact normalized match of both parts of a
structured Name answer can do the same. These are staff-visible clues only.
Amount, receipt identity, checkout-handle possession, name similarity, or any
non-exact email still requires an explicit confirmation. Suggestion ranking
must not leak into activation, owner mail, or ticket delivery.

A purchaser who is still pending can choose **I paid with a different email**
and enter the alternate address used at Zeffy. The public response is the same
whether or not an eligible payment exists. The request is rate-limited and,
when eligible, sends a short-lived one-time verification link only to the
alternate address. Its emailed link opens the event-scoped
`/events/:eventSlug/payment-inquiry` page. It does not send evidence or a link
to the original linking email, because that would not prove control of the
provider address.

Consuming a valid alternate-email link proves control of that address for one
event, year, and flow. It creates or updates one payment-link inquiry in that
scope for staff review; it does not itself associate a payment. Invalid,
expired, replayed, altered, wrong-purpose, or cross-event capabilities return
one data-free result and cannot create duplicate inquiries. The raw verification
capability is one-time authority and is never persisted as the lookup key.

When staff confirms a non-exact association, the mutation transactionally
rechecks that the provider payment is still succeeded and non-refunded, the
campaign still resolves to the intended event/year/flow, the payment remains
inside the permitted window, and neither side has acquired a conflicting
association. Only after those checks pass may the payment be linked. This final
check prevents a stale suggestion or already-reviewed browser page from
overriding newer provider or staff state.

## Ticket creation, delivery, and account ownership

Every succeeded provider ticket item projects exactly one idempotent Band
Boosters ticket. The ticket retains its distinct provider item identity, exact
provider option ID when supplied, resolved local label when bound, occurrence
when the provider supplies one, and the event date when it can be resolved.
Option grouping may enrich a registration-level quantity summary, but never
collapses those ticket records. Each ticket receives one unique door check-in
code. Reprocessing a provider
callback must find the same projected ticket rather than minting a second ticket
or replacing its check-in code. Every distinct additive provider payment
associated with a registration participates in ticket lookup; compatibility
with the first payment identity must not hide later purchases.

Option binding enriches purchase explanation only. It does not change privacy
or capability boundaries, exact-email association, refund projection, account
entitlement, ticket-grant authorization, or mobile-wallet behavior.

Ticket delivery uses the `ticket_access` message in the existing template and
outbox pipeline. It includes a **View my tickets** link built with the configured
public-origin helper. No route or message hard-codes a production domain, and no
public URL exposes raw internal payment or registration identifiers. The link
contains one random ticket-access grant whose server-side record stores only a
purpose-separated digest. A grant is revocable and independent of the older,
short-lived read-only registration-access capability.

Before a mismatched payment is associated with a local registration, ticket
access is delivered only to the provider email. After staff verifies and links
the payment, the same ticket grant is delivered to both the linking email and
provider email when they differ. Recipient normalization removes duplicates.
Provider callback replay and repeated projection reuse the same grant and mail
idempotency boundary, so neither produces another grant or duplicate delivery.

When either the provider email or the linked registration email belongs to an
existing student or parent account, the tickets are assigned to that account.
They then appear in the account's normal ticket dashboard and day-of links view,
subject to the authorization those existing views already enforce. Anonymous
grant access remains available for legitimate guest purchasers and does not
weaken account-scoped authorization.

## Verified ticket wallet, response editing, and refunds

`/tickets/<opaque-grant>` renders a mobile-friendly private wallet. It shows one
purchased ticket per page with previous/next actions, a current-position
indicator, ticket label, attendee, validity status, and the door check-in code.
The route is dynamic, private, `no-store`, and `noindex`. Invalid, expired,
revoked, altered, or wrong-purpose grants produce one data-free unavailable
result without revealing ticket, payment, registration, or email existence.

After a payment is linked, the wallet also renders the effective custom
registration answers as a polished read-only form. Each answer that is both in
the saved flow snapshot and purchaser-editable has an accessible edit-icon
action with explicit save and cancel states. Updates are validated against the
snapshotted field type, use version checking to prevent lost updates, and add an
audit record. The purchaser override becomes the effective displayed answer;
later provider re-sync preserves it instead of restoring the older source
value.

This editing authority is deliberately narrow. The linking email, provider
email, ticket type, quantity, ticket identity, payment or refund state, provider
payload, internal identifiers, and all other system fields are read-only. A
ticket grant cannot add fields that were not captured in the registration flow
snapshot, change the tickets purchased, or broaden itself to another event or
flow. Name answers retain their structured first/last pair and the complete-or-
blank validation rules when edited.

The wallet's **Request a refund** action creates one staff-reviewed request for
the payment and may include optional purchaser context. The success state says
explicitly that no automatic refund occurred. A pending request neither
invalidates a ticket nor marks a provider payment refunded; only an actual
provider refund update changes payment and ticket validity. At most one active
refund request can exist for a payment, preventing repeated clicks or replay
from opening duplicates.

New verification, ticket-grant, inquiry, and refund-request records live in the
server-only `payment_email_verifications`, `ticket_access_grants`,
`payment_link_inquiries`, and `event_refund_requests` collections. Their public
routes are purpose-bound, scope-checked,
private and `no-store`, and constrained by rate and request-size limits. Reads
and mutations use one-time or revocable authority according to the operation;
none grants general document or collection access.

## Public discovery and direct access

The public event page lists only flows that are both enabled and marked visible.
Each action uses the flow's configured label and canonical direct URL, in the
administrator-defined order. Hidden flows are intentionally absent from public
discovery but remain usable through their direct links while enabled.

Each advertised flow uses one equal-height action card whose whole surface is
the primary link, with its visual call to action aligned at the bottom so mixed
amounts of pricing copy do not create a ragged action row. A recovery action,
when configured, remains a separate keyboard-operable sibling above the primary
link overlay; interactive elements are never nested. This lets pointer and
keyboard users activate the intended primary route without making recovery
ambiguous.

The parent hosted event must also be enabled. A disabled/archive event resolves
no direct flow, does not advertise registration actions, and rejects a direct
group, standard, or ticket request. A submitted registration flow URL receives
the same “registration not open” conflict response used for disabled or
wrong-kind submissions; only an unknown event slug is not found.

Each flow separately chooses whether to advertise recovery. Group and standard
flows label the action “Check your registration”; ticket flows label it “View
your tickets.” The actions share this canonical request URL:

```text
/events/:eventSlug/check-registration
```

That route contains only an email-request form. It never links directly to a
registration record, includes a registration identifier, or reveals hidden
registration flows. On the public event page an action appears only within a
publicly visible flow whose `showRecovery` is true. On an enabled direct flow
page the same setting controls the action even when the flow is hidden from the
event page.

## Anonymous confirmation security boundary

Email recovery proves control of the contact address without creating a user
account or exposing whether the address exists.

1. A visitor submits an email address on the event's check-registration page.
2. After resolving an enabled event and applying the shared IP limit, the web
   request handler writes every valid event/email request to the durable
   `outbox` in the same recipient-free request shape. It does not query for a
   matching registration before enqueue. The browser always receives the same
   generic response and never waits for SMTP or another provider-dependent
   send.
3. Immediately before outbox delivery, the Functions dispatcher privately
   queries the event year and normalized contact email. It completes an
   unmatched request without adding a recipient. For a match, it replaces the
   request payload with a normal one-recipient announcement and issues the
   confirmation token at that time, so the public request path's response and
   durable write count do not reveal eligibility.
4. The delivered email contains an expiring,
   purpose-bound link. Current `v2` tokens use AES-GCM authenticated encryption,
   so the normalized contact email is bound into the authority but is opaque in
   browser history and logs. Previously issued signed `v1` links remain readable
   only until their existing expiry.
5. The confirmation endpoint validates token authentication, purpose, expiry,
   event id, year, and email binding before reading private records.
6. A valid link renders a server-curated, read-only view of all registrations
   and tickets for that event year and contact email, regardless of which flow
   advertised the action. It may show the owner a
   matching payment-gated submission as awaiting payment, without calling it
   registered. The response omits private internal fields and does not grant
   general collection access.
7. Tickets are joined by provider/payment identity and then constrained again
   to the hosted-event slug and year. Cross-provider payment IDs or tickets for
   another event cannot enter the response.
8. Successful and unavailable confirmation responses set private `no-store`
   cache headers, and the route is forced dynamic. Invalid, altered,
   wrong-purpose, or expired links reveal no registration or ticket data.

The request response must not disclose match status through copy, status codes,
record counts, timing-dependent UI, or identifier-bearing redirects. This older
registration-access link remains read-only and is not an administrative
credential. It is separate from a ticket-access grant: only the latter can
authorize edits to eligible snapshotted custom answers or create a staff-reviewed
refund request, and neither capability can directly cancel or refund a purchase.

This guest boundary complements rather than replaces account ownership.
Existing signed-in hosted-event summaries continue to resolve ownership through
verified submitter identity, verified contact email, and guarded participant
relationships. The signed-in `/registration/me` discovery excludes
`paymentStatus: "pending"`; only the secure email-owner view shows the awaiting
payment state.

## Immutable snapshots and mixed administration

Every submitted group or standard registration and every projected ticket
purchase stores an immutable `flowSnapshot` containing the selected flow's
`id`, `slug`, `label`, mechanical `kind`, deep-copied `fields`, and deep-copied
ordered `prices`, including each saved Zeffy option binding needed to explain a
historical purchase. Mutable availability, visibility, outcome, payment, and
checkout controls are deliberately excluded.

Admin roster rows and CSV exports interpret each record from this saved
snapshot, not the current flow editor. A single event can therefore contain
group, standard, and ticket rows with different buyer/participant schemas and
price labels. Pending rows may remain outside completed-registration exports.
Included paid rows export the resolved purchased option labels, quantities,
subtotals, unmapped state where applicable, and authoritative provider total;
they do not export every configured price as purchased. Renaming, reordering,
repricing, hiding, unbinding, or deleting the live flow does not rewrite
historical meaning. Legacy rows without a snapshot continue to use the legacy
year-wide schema and invoice join.

Cloning an event year deep-copies the complete nested flow list, including field
options/defaults, prices, and checkout mapping, so edits in the new year cannot
mutate the prior year's configuration.

## Backward compatibility

Only hosted-event years where the `registrationFlows` field is absent retain
their existing public behavior through derived defaults:

- existing registration events continue to use the legacy
  `/events/:slug/register` route and their current organization/student form,
  invoice behavior, custom questions, registration pricing, and external
  registration options;
- existing ticket events continue to use their configured ticket URLs and
  pricing behavior; and
- existing signed-in ownership summaries continue to work.

An explicitly stored `registrationFlows: []` is authoritative and means there
are no registration or ticket paths; it must not invoke legacy defaults.
Missing payment-gate and provider-mapping properties on older rows normalize to their prior
behavior: group and standard submissions complete immediately according to
their existing invoice or confirmation outcome, and manual ticket checkout
continues to be a link-only handoff. Connecting Zeffy alone never changes a
stored flow's lifecycle. Existing invoice outcomes, manual checkout, and
disconnected-site behavior therefore require no migration.

The legacy route remains valid for absent-flow records. Once an administrator
saves the current editor, the complete nested array becomes the event year's
source of truth, and current saves do not write `registrationType` or the
year-wide unit, tier, ticket-price, pricing-visibility, or recovery controls.

## Drumline Festival configuration

Drumline Festival starts with two ordered flows:

1. **Register your group** — `group`, enabled, invoice outcome, configured buyer
   fields, a zero-dollar Group registration price per line, public pricing and
   recovery, and no registrant-type property.
2. **Purchase tickets** — `tickets`, enabled, with General ($12), Student /
   senior / military ($7), and Family ($25) price rows plus a manual checkout URL
   retained until an administrator chooses `zeffy` and selects a campaign from a
   connected integration.

Each flow may advertise its recovery action. The group action says “Check your
registration,” the ticket action says “View your tickets,” and both recover all
matching registrations and tickets for the submitted event/contact email.

The idempotent hosted-event seed persists complete canonical `registrationFlows`
into the 2026 Drumline Festival year document. Both rows own `prices`,
`showPricingOnPublicPage`, `pricingDescription`, and `showRecovery`; the group
row owns its reusable `fields`, while the ticket row has no registration-field
classification. The ticket checkout uses the manual
`https://grizzlyband.org` fallback until an administrator saves a connected
Zeffy campaign. The retained top-level lookup value is compatibility data, not
the current flows' authority.

## Admin and public interaction requirements

- Flow order, label, mechanical kind, first-price summary, enabled state,
  visibility, local outcome, and ticket checkout source must be explicit in the
  independently collapsible editor cards and summary rows.
- Validation and save failures remain visible and associated with the editor;
  collapsing one card must not hide an unresolved failure.
- Current flow cards must not render or persist a registrant-type selector.
  Group and standard cards edit reusable buyer/participant fields, including
  select `allowOther` and structured Name; ticket cards omit registration fields.
- Every current flow kind uses the same ordered price editor. The year-wide Unit
  amount, Registration date pricing, and Ticket prices controls are legacy-only
  and appear only while `registrationFlows` is absent.
- Hidden, disabled, invoiced, confirmation-only, manual-checkout, and
  provider-bound states need textual labels; color alone is insufficient.
- A Zeffy-backed form presents currently available prices as a labelled,
  read-only **Available at checkout** summary and has one final submit action.
  It does not claim to preselect type or quantity; required-field errors appear
  beside their controls and are announced accessibly without making a request.
- The accepted submission remains local and shows the submitted-answer summary,
  exact linking email and use-at-Zeffy instruction, announced Copy feedback, and
  one **Pay now** action. A valid resumed capability restores the same state from
  a private server response without exposing answers in browser storage.
- The shared price editor exposes `allowMultiple` as **Allow multiple (supported
  providers only)**. Current Zeffy checkout ignores it because Zeffy supplies no
  session-prefill API; it must not create a local quantity control.
- Read-only Zeffy pricing, structured-name validation, required errors, saved
  confirmation, conditional cart, bearer-only status, popup fallback, paid
  confirmation, repeat provider payments, exact-email reconciliation, and
  full-card event actions require behavior coverage.
- Confirmation, alternate-email inquiry, staff reconciliation, ticket paging,
  read-only answers, edit/save/cancel, and refund-request views must preserve the
  Band Boosters design system, visibly focus keyboard controls, announce state,
  avoid layout-shifting hover effects, and avoid horizontal overflow at 375,
  768, 1024, and 1440 CSS pixels.
- Suggestion ranking must visually distinguish a clue from an association, and
  every non-exact-email match must require an explicit confirmation.
- Ticket-wallet previous/next and position controls must remain understandable
  with one ticket visible per page. Each answer's edit-icon action needs an
  accessible name and must expose unambiguous save and cancel state.
- Copy-link actions and all configuration controls must be keyboard operable and
  visibly focused.
- Flow cards, field editors, confirmation views, and public calls to action must
  remain usable at narrow widths without horizontal overflow.
- Public flow cards use their whole surface as the primary direct-flow link,
  keep the visual action aligned at the bottom, and preserve recovery as a
  separate non-nested link with its own focus treatment.
- Reordering must have an accessible keyboard path and must preserve stable flow
  identities and slugs.
- Provider selection must explain why Zeffy campaigns are unavailable when the
  integration is disconnected without presenting a nonfunctional choice.
- Campaign mapping and setup guidance must be available for group, standard,
  and ticket flows when Zeffy is connected.
- Readiness states must use text as well as visual treatment and must distinguish
  configured webhook credentials from a callback that has actually arrived.
- A mapped campaign must be named and linked directly, with a separate
  accessible edit-icon action. Zeffy setup help uses a named `?` icon when ready
  and a named warning icon when connection or webhook attention is required.
- Webhook-secret instructions and controls are primary-administrator-only and
  appear only until the secret is configured. Other event editors see an alert
  directing them to the administrator.
- A mapped campaign's normalized options populate each price's **Zeffy checkout
  option** selector. Bound, unbound, and stale states remain explicit; duplicate
  non-empty IDs are rejected and labels or amounts never repair a binding.
- Pending Zeffy-owned rows display **Payment pending** with unknown option and
  amount, and provide no local completion action. Paid rows display only their
  exact-ID **Purchased option(s)** groups and the authoritative provider total.
- Reconciliation previews mapped and unmapped provider items before association;
  exact-email and staff-confirmed links produce the same additive, idempotent
  purchase projection without weakening event/campaign scope.
- Ticket materialization preserves one distinct ticket per provider item even
  when option grouping produces a shared label and quantity summary.

## Known residual abuse boundary

Production email-access requests use the shared IP rate limiter. Anonymous local
registration POSTs do not yet have a rate limit, CAPTCHA, or client idempotency
key. Repeating a valid group or standard submission can therefore create another
registration, allocate another invoice when configured, and enqueue another
message. Provider-payment sync is independently idempotent and is not affected
by this limitation. Until the public-submit boundary is hardened, operators
should watch for duplicate local registrations and avoid treating a hidden URL
as an anti-abuse control.

## Alternatives considered

- **One event-wide kind:** rejected because one year can simultaneously accept
  bands, individuals, vendors, and ticket buyers.
- **Visibility doubles as enabled state:** rejected because administrators need
  active invitation-only links that are not publicly advertised.
- **Group forms always invoice:** rejected because billing requirements vary by
  organization, audience, and event.
- **Zeffy required for tickets:** rejected because integration availability and
  campaign readiness vary by site and event.
- **Campaign creation through the Zeffy API:** rejected because Zeffy's campaign
  API is read-only; the safe workflow opens Zeffy and refreshes the catalog.
- **One checkout URL per Zeffy rate:** rejected because Zeffy rates belong to a
  single campaign checkout and do not expose rate-specific URLs or a public
  hosted-session prefill endpoint. The saved rate supports display and editor
  mapping, while Zeffy remains authoritative for buyer type and quantity.
- **Locally select a Zeffy price before submitting:** rejected because the
  selection cannot be transferred to Zeffy's hosted checkout. A read-only
  preview plus explicit “select at checkout” guidance is honest about the
  provider boundary.
- **Use a custom price URL as reconciliation authority:** rejected because an
  outbound URL does not prove which provider campaign owns a payment. Secure
  status checks require the exact event/year/flow campaign mapping.
- **Persist the form as a browser cart:** rejected because registration answers
  contain personal data and are unnecessary for resume. The browser retains
  only an opaque expiring handle, expiration, and return route.
- **Treat popup closure or return navigation as payment failure:** rejected
  because Band Boosters does not control Zeffy's checkout window. The pending
  cart remains resumable until an authoritative webhook or scoped
  reconciliation proves payment.
- **Show a permanent cart icon:** rejected because it suggests a shopping cart
  where none exists. The public header link appears only for the browser's one
  unexpired unfinished checkout.
- **One webhook per flow:** rejected because Zeffy's callback is configured at
  the account/provider level; per-flow routing belongs in campaign mappings.
- **Show webhook-secret setup to every event editor:** rejected because provider
  secrets are primary-administrator configuration. Non-primary editors receive
  actionable status without secret controls.
- **Activate by name, amount, or approximate match:** rejected because that can
  register the wrong person or group. Payment-gated activation requires the
  mapped flow and normalized contact email.
- **Create a group/standard registration from unmatched payment data:** rejected
  because Zeffy does not contain the complete local form submission.
- **Treat webhook-secret generation as delivery proof:** rejected because a
  configured endpoint may never have been installed correctly in Zeffy.
- **Send confirmation on every callback retry:** rejected because provider
  retries are expected and would produce duplicate buyer mail.
- **Automatically link likely names or near emails:** rejected because a strong
  suggestion is still not proof. Only exact normalized linking/provider email
  may associate automatically; all other matches require transactional staff
  confirmation.
- **Treat alternate-email verification as association:** rejected because email
  control proves only the address. It creates a scoped inquiry for review rather
  than deciding which payment belongs to which registration.
- **Reuse the checkout handle or old registration-access link for tickets:**
  rejected because status resume, read-only registration recovery, and durable
  revocable ticket access are different purposes and lifetimes.
- **Issue a new grant for every callback or recipient:** rejected because replay
  would multiply credentials and mail. One payment ticket set reuses one
  revocable grant and idempotent delivery boundary.
- **Let purchasers edit provider or ticket facts:** rejected because the grant
  is authority only for eligible snapshotted custom answers. Provider payment
  state and purchased ticket identity remain authoritative system data.
- **Automatically refund from the public wallet:** rejected because refunds are
  manually reviewed. The public action records a request, and only provider
  refund state changes ticket validity.
- **Hard-code the public ticket host:** rejected because deployments use
  different origins. Every ticket URL is composed through configured public
  origin handling.
- **Require an account to view confirmation:** rejected because external school
  contacts and concert attendees are legitimate guests; email possession plus a
  short-lived scoped link supplies the narrower proof needed.
