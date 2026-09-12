<!--
Copyright (c) 2026 Band Boosters Platforms. Use of this file is governed by
the LICENSE file in the repository root.

Operator guide for configuring, publishing, sharing, and supporting authoritative
hosted-event registration flows, including reusable fields, exact Zeffy option
bindings, anonymous resumable checkout, provider-authoritative purchase summaries,
exact-email reconciliation and staff review, ticket delivery and purchaser access,
refund requests, immutable history and exports, hidden links, and no-login access.
-->

# Hosted-event registration flow operations

Use the hosted-event year settings to configure every way a guest can register
or buy tickets. Flows are year-specific: changing this year's flow list does not
rewrite an archived year or preconfigure the next cloned year unless cloning
explicitly copies those settings.

For the security boundary, compatibility rules, and design rationale, see
[Hosted-event registration flows](../Designs/hosted-event-registration-flows.md).

## Create and order flows

For each audience:

1. Add a flow and choose `group`, `standard`, or `tickets`.
2. Set the public label. This is the action text guests see.
3. Choose the stable slug carefully. The copied URL is
   `/events/:eventSlug/register/:flowSlug`; later label and settings changes do
   not require a new link.
4. Configure reusable buyer/participant fields for a group or standard flow, or
   checkout for a ticket flow.
5. Configure this flow's one ordered price list, public pricing copy, and
   pricing visibility.
6. Enable the flow when the direct link is ready for use.
7. Separately choose whether to show the flow on the public event page and
   whether to show its recovery action.
8. Reorder flows into the sequence guests should see.

Use the editor's copy-link action to distribute a flow directly. A hidden,
enabled flow works from its copied URL. A disabled flow does not, regardless of
visibility or whether its URL was shared previously.

Current saves write the complete ordered `registrationFlows` array. Every row
stores `id`, `slug`, `label`, mechanical `kind`, `enabled`,
`showOnPublicPage`, `showRecovery`, `prices`, `showPricingOnPublicPage`, and
`pricingDescription`. Group/standard rows add `fields`, `outcome`,
`paymentRequired`, and optional Zeffy `checkout`; ticket rows add manual or
Zeffy `checkout`. Current flows do not store `registrantType`.

Readers still accept the earlier `registrationFields`, `ticketCheckout`,
`manualCheckoutUrl`, `zeffyCampaignId`, `zeffyCheckoutUrl`, and nested pricing
aliases. Do not hand-edit a year document into another shape; an Admin save
normalizes supported rows to the canonical representation.

## Choose the form shape

Choose **Group** for the group-registration mechanics used by a school, band,
ensemble, drumline, or other organization. Choose **Standard** for the local
registration mechanics used by an individual, student, vendor, or other
contact. These kinds do not classify registrants or inject hidden questions.

For either local flow, use **Add question** to configure every flow-scoped field
the form needs. Contact email is always collected as the event-wide recovery
identity; organization, ensemble, director, phone, billing, student, vendor,
and other data comes from these reusable definitions.
Each row controls the label, whether the answer belongs to the contact/buyer or
each participant, its text/email/phone/long-text/instrument/dropdown/multi-select
type, whether it is required, and the comma-separated options required by select
types. A dropdown can enable **Allow custom Other entry** (`allowOther`). The
stable question key survives edits and reordering. Removing a question affects
only that flow; legacy year-wide questions remain separate.

Choose **Name** (`type: "name"`) when one question should collect a person's first and last name.
It appears to the guest as two labelled inputs under the one question. A required
Name needs both parts. An optional Name accepts both parts blank, but not just a
first or just a last name. Details, exports, saved checkout confirmation, and
ticket-wallet answers preserve the pair. Historical string-valued name answers
remain readable and are not automatically split or rewritten.

Both form kinds accept anonymous submissions. Do not instruct external guests
to create accounts. Signed-in ownership summaries remain available to users who
already have an account and a qualifying relationship. A current flow ignores
an older year-wide `registrationType`; that enum is consulted only while
adapting a record whose `registrationFlows` field is absent.

## Configure one price list per flow

Every flow card has the same **Prices for this flow** editor. Keep the rows in
the order guests should see them. Each row owns:

- stable id, label, amount, and unit;
- optional row description;
- optional inclusive start/end dates; and
- optional purchase link; and
- **Allow multiple (supported providers only)** future-provider capability.

After mapping the flow to a Zeffy campaign, each row also has a **Zeffy checkout
option** selector. A bound row names its selected provider option. An unbound row
and a stale binding whose option is no longer returned by Zeffy remain visibly
different from a valid binding. Save preserves the exact provider option ID and
stores it in the local price's `zeffyRateId` field. Save rejects assigning one
non-empty ID to two rows in this flow. It never binds or repairs a row because
its label or amount resembles a Zeffy option.

Use **Pricing description** for flow-level context and **Show pricing on public
event page** to control whether a public event card displays the rows. An
enabled direct flow page can still display its prices when the flow itself is
hidden from the event page.

For a Zeffy-backed group or standard flow, guests do not choose a local price or
quantity. Currently available rows appear in configured order under the
read-only **Available at checkout** heading, with each label and formatted
price. The page tells the guest to select ticket type and quantity on Zeffy's
secure checkout. Future and expired rows are omitted from this available
summary.

Zeffy's current public API can read campaign rates but offers no hosted online
checkout/session endpoint that can prefill rate or quantity. Every mapped rate
uses the same campaign URL. **Allow multiple** therefore records capability for
a future provider only; enabling it does not create a local quantity control or
change the current Zeffy experience.

The one final registration action validates every required local answer.
Missing values are announced beside their controls and produce no request. A
valid submission sends completed registration answers once, without a local
Zeffy price or quantity intent; the server determines the mapped Zeffy
destination. The save remains on Band Boosters and shows the submitted answers,
the exact linking email with instructions to use it at Zeffy, an accessible
**Copy** action with announced success or failure, and one **Pay now** action.
Direct external rows and ticket flows retain their safe whole-card
links and availability behavior, and the provider-reported completed payment
remains authoritative for type, quantity, and paid total.

Do not look for separate Unit amount, Registration date pricing, or Ticket
prices editors on a current flow. Those controls are shown only for a legacy
year where `registrationFlows` is absent.

## Choose the local outcome

Every group or standard flow has its own outcome:

- **Invoice** creates the existing numbered event invoice and sends the
  established payment instructions after a successful submission. Use this for
  school or organization registrations that need a purchase order or check and
  for any individual/vendor registration that should be invoiced.
- **Confirmation** records and confirms the registration without creating an
  invoice. Use this for free registrations or payment handled outside the
  registration workflow.

These outcomes remain meaningful when **Require payment before registration** is
on, but Zeffy remains the option-selection and amount authority. Both outcomes
store a pending registration and continue to the mapped checkout without
claiming a purchased local option or known amount. **Invoice** records the
intended outcome but does not create or email a pre-checkout local invoice for a
price the purchaser has not selected. If payment produces an internal paid
invoice, its identity and total come from the associated provider payment.
**Confirmation only** creates no invoice and sends no premature confirmation;
the provider callback sends the first confirmation after activation. Immediate
manual and non-Zeffy invoice flows retain their existing invoice behavior.

The pending registration saves the selected outcome. Association uses that
saved outcome, not a later edit to the live flow, when deciding whether to create
the provider-backed invoice.

All local flows require contact email for recovery. Any phone, organization,
ensemble, contact name, billing address, or participant requirement must be an
explicit required field in that flow. Invoice payer details use configured buyer
answers where available and contact email as the fallback.

Confirm the outcome before sharing the flow. The editor must visibly identify
which flows invoice and which only confirm so similarly named flows are not
mistaken for one another.

## Decide whether payment completes registration

A group or standard flow can independently require provider payment before a
guest becomes registered. This is separate from choosing group versus standard
and separate from choosing invoice versus confirmation. Existing flows remain
immediate unless an administrator explicitly enables the payment requirement.

Enabling **Require payment before registration** on a flow mapped to a Zeffy
campaign makes the flow **checkout-first**. Zeffy cannot carry the buyer's email
or answers into its checkout and cannot return a token, so the platform no
longer asks the buyer for anything before payment. The buyer sees the price
preview, the list of questions they will answer after payment, and **Buy now**.
The flow editor hides **Collect registration information before checkout** for
such flows and explains that details are collected after payment in the buyer's
wallet. Ticket flows mapped to Zeffy use the same Buy now path.

For a checkout-first flow:

1. Connect Zeffy for the site, enable **Require payment before registration**,
   and map the intended campaign to this flow. Bind each local price to its
   exact Zeffy checkout option.
2. Mark the questions the buyer must answer as required. Only required
   questions gate completion; optional ones can be answered in the wallet later.
3. Open the public flow and choose **Buy now**. The page issues an emailless
   checkout capability, opens Zeffy, and shows "Waiting for your payment" with
   the copy "If you completed your payment, watch your email for next steps. If
   you didn't, you can go back and purchase." plus **Buy again**. Zeffy sends no
   cancel callback, so this copy cannot be narrowed.
4. Complete the mapped checkout with any email.
5. Verify that ingestion (the production webhook, the return-page poll, or
   **Sync now**) creates the registration with `paymentStatus: "paid"`, the
   buyer's provider email, the exact purchased option groups, and
   `detailsStatus: "incomplete"` when required questions remain, and that it
   sends one wallet email whose subject is **Finish your registration for
   <event>** (or **Your tickets for <event>** when nothing is required).
6. Follow the wallet link, answer the required questions, and add participants
   where the flow asks for them. The registration flips to
   `detailsStatus: "complete"` and the admin row changes from **Details
   pending** to **Paid**.
7. Retry or re-sync the same payment and verify that it neither creates a second
   registration nor resends the wallet email.

The emailed wallet grant is the only way a guest reaches a checkout-first
registration; no public page looks a registration up by email. A signed-in
member whose **verified** account email matches the buyer email is redirected
straight to their wallet when they return from checkout.

Flows with a mapped campaign but **without** the payment requirement keep the
local form. For those optional-payment flows the exact normalized-email
association rules below still apply: a paid buyer who used another email is
resolved through the reconciliation workflow, similar names or amounts never
associate automatically, and an ambiguous same-scope email stops automatic
association.

## Support resumable external payment

A checkout-first flow uses a same-browser cart lifecycle so an anonymous guest
can leave Band Boosters, abandon or close Zeffy, and return later. The browser
stores only an opaque resume handle, its expiration, and the registration
return route. Only the newest unfinished checkout is retained; starting another
replaces the earlier cart handle.

**Buy now** issues the checkout capability, saves it, and opens the
server-selected Zeffy page: desktop browsers use a popup-style window and fall
back safely to the current tab if the popup is blocked; small screens use the
current tab. Closing Zeffy or returning with the Back action leaves the checkout
pending; it does not prove cancellation.

Returning to the saved registration route shows **Waiting for your payment**
with the copy "If you completed your payment, watch your email for next steps.
If you didn't, you can go back and purchase.", **Buy again**, **Check payment
status**, and the flow's recovery link. Once a payment is ingested the page
shows **Payment received** and tells the buyer to check the email they used at
checkout for a link to finish their registration (when required questions
remain) or to view their tickets. A signed-in member whose verified account
email matches the buyer email is redirected to the wallet instead.

While that handle remains unexpired and pending, the public header shows a
cart-shaped **Resume purchase** link that returns to the stored route. The cart
disappears after paid confirmation, invalidation, or expiry.

### Payment status and missed webhooks

The return page checks payment status through the opaque handle, sending a
Firebase ID token in `X-Viewer-Token` when the visitor is signed in. Invalid,
expired, altered, or cross-event handles all return the same data-free result.
The raw handle is sent only as an authorization bearer credential and never
appears in a URL.

For a valid pending handle the server reconciles with Zeffy in case the webhook
was missed (alpha never receives it: Zeffy stores one callback URL per
organization). Reconciliation is limited to the exact mapped campaign and to
payments created between checkout issuance and expiry; every succeeded,
non-refunded payment found runs through the same ingestion pipeline the
webhook uses. The browser can refresh status every 15 seconds and on return,
focus, or visibility, but provider access is claimed at most once per minute
and reads no more than three result pages per attempt. Because ingestion and
the wallet email are idempotent per provider payment id, a payment seen by both
the production webhook and an alpha return poll is created and emailed once.
Two buyers checking out the same campaign at once may ingest each other's
payments; that is harmless because each wallet email goes only to its buyer.

A provider timeout or reconciliation failure remains pending and resumable; it
must not clear the cart or show payment received.

### Troubleshoot an unfinished checkout

- **The cart is absent:** confirm that this browser has an unexpired pending
  handle. Paid, invalid, and expired handles intentionally hide it; another
  browser or device does not share it.
- **Buy now says registration is not open:** verify the flow is enabled, the
  event is enabled, the flow requires payment, and it has a Zeffy checkout URL.
- **The popup did not appear:** browser popup protection may have blocked it.
  The same checkout continues in the current tab, or the buyer can use **Buy
  again**.
- **Payment remains pending after return:** allow the throttled status check
  to run and verify the campaign mapping and provider health. On alpha, or after
  the checkout window expired, use **Sync now** in payment settings.
- **The buyer never got the wallet email:** check the outbox document
  `ticket-access-registration_<registration id>`; the wallet email is
  transactional and cannot be suppressed by an announcements opt-out. Resend
  through the reconciliation workspace or send the recovery link.
- **A registration shows Details pending:** the buyer paid but has not answered
  every required question. The detail view lists what is still needed; the
  buyer completes it from their wallet link.

## Configure payment campaigns and ticket checkout

Campaign mapping is available on group, standard, and ticket flows when Zeffy
is connected for the site. A tickets flow additionally has one selected
checkout mode.

### Manual checkout

Enter the complete external checkout URL and choose `manual`. Use this when the
site has no Zeffy connection, the campaign is not ready, or the event uses
another hosted checkout. Verify the copied registration-flow URL redirects to
the intended checkout before publishing it.

An arbitrary manual URL is only a handoff. Do not expect ticket materialization,
refund updates, or payment idempotency unless that checkout also enters through
a configured payment integration.

### Map a Zeffy campaign

Connect Zeffy in the site's payment integration settings first. Then open the
flow's dedicated mapping experience. It lists campaigns from the connected
account, marks the flow's current mapping, and can refresh the catalog. Select
the intended campaign and choose **Save mapping**; administrators should not
have to paste provider identifiers. That button immediately runs the hosted-event
settings save, including atomic campaign-target reconciliation, displays
**Saving mapping…**, and closes only when persistence succeeds.

After campaign mapping, bind each local price deliberately with its **Zeffy
checkout option** selector. Confirm each row shows the intended exact remote
option and that no two rows use the same non-empty option ID. A local label or
amount is not a fallback binding. If a refresh shows an option as stale, either
select the replacement deliberately after verifying it in Zeffy or leave the
row visibly unbound until the correct option exists. Do not rename or reprice a
local row in an attempt to repair the binding.

For a group or standard flow, the mapping routes a completed payment to the
same-email pending submission when payment is required. For a ticket flow, the
mapping supplies the checkout and routes completed purchases to registration
and ticket projection. A group/standard mapping is retained even while its
payment requirement is off, so the campaign may be prepared without changing
the public submission lifecycle.

The exact mapping is also required for secure return-time reconciliation of a
form-backed checkout. A custom URL on a price is an outbound destination only;
it does not authorize a provider search and cannot establish event/year/flow
ownership. Do not publish resume-status language until the intended Zeffy
campaign is mapped and verified.

Verify that the campaign belongs to the intended event year and flow before
publishing. Synced purchases are associated with that event year and flow,
processed idempotently, and materialized into ticket entitlements. Later refund
sync marks those tickets refunded through the established payment pipeline.

If Zeffy is disconnected, the editor explains that it must be connected before
mapping. It does not present a mapping action that looks usable. An existing
Zeffy-bound flow remains identifiable as disconnected and, for a ticket flow,
must communicate whether a manual fallback is available. It cannot be newly
mapped while disconnected. Retain a manual ticket URL until the integration is
connected and an administrator explicitly selects a campaign.

One Zeffy campaign can fund several non-event target kinds, but it can bind to
only one hosted-event flow globally. A save rejects duplicate flows in the same
year and a campaign already bound to another hosted event/year. Rebinding inside
the current year moves the target. Switching away from Zeffy or removing the
flow unbinds that hosted-event target and clears its legacy singular target
without deleting unrelated campaign targets.

Normal provider sync materializes flow-bound ticket lines before payment-match
confidence is decided. Re-sync uses deterministic ticket IDs and preserves the
check-in code and established buyer/family ownership. Full refunds mark the
entitlements refunded and revoke only the matching provider/payment tickets.

## Follow the Zeffy setup walkthrough

Zeffy's API can read campaigns but cannot create them, and webhook installation
is manual. The setup walkthrough therefore coordinates work between the two
systems instead of claiming to automate it.

### 1. Verify the site connection

The connection is ready only when the site has usable Zeffy credentials and can
load the campaign catalog. If it is disconnected, follow the protected payment
integration setup before continuing. A connected API does not prove that any
flow is mapped or that the webhook is working.

### 2. Create or inspect the campaign in Zeffy

Use the walkthrough's external Zeffy campaign/setup link. It opens in a new tab
so the hosted-event editor remains available. Create and configure the campaign
in Zeffy, including its ticket or payment choices and the buyer email collection
needed for correlation. Return to Band Boosters, refresh the campaign catalog,
and map the new campaign to the intended flow.

### 3. Generate and install the callback

The webhook applies to the site's Zeffy provider connection, not to one flow.
If no webhook secret is configured, choose **Generate webhook secret**. If one
is configured but its token-bearing URL was not retained, choose **Rotate
webhook secret**. Generation or rotation returns the token once and changes
**Exact callback URL** to the usable
`/api/payments/webhook/zeffy?token=…` form. Copy it immediately into Zeffy's
Integrations settings and treat it as a secret. After reload, Band Boosters
retains only the verifier hash and cannot reconstruct the token; rotation is the
recovery path. Rotation invalidates the old callback credential.

Generating the secret establishes **Webhook secret configured** only. It does
not prove that the callback was copied into Zeffy or that Zeffy has delivered an
event. Do not copy the base callback path shown before a one-time token is
available; it cannot authenticate a Zeffy request by itself.

### 4. Validate delivery and mapping

Complete a controlled purchase or other safe Zeffy test that causes the
supported `payment.completed` event. Return to the walkthrough and inspect the
**Last accepted webhook** time. A present time means Band Boosters authenticated
the token, re-fetched a succeeded payment from Zeffy, processed it through the
shared ingestion pipeline, and then recorded the timestamp. It does not
guarantee that all historic payments arrived. A missing time after setup means
delivery is not yet proven, even if the secret is configured.

For a payment-gated group or standard flow, submit the local form first and use
the same normalized email at checkout. Verify pending status before payment and
active status afterward. For a ticket flow, verify that the payment creates the
payment-backed registration and ticket without a prior local submission.

Inspect the paid registration's **Purchased option(s)** summary. Each exact
provider `rate_id` (normalized as `providerOptionId`) should resolve to the local
label whose snapshotted `zeffyRateId` is identical, with quantity equal to the
number of matching provider items and subtotal equal to their summed amounts. A
bound free option must read `$0.00`, not unknown. Missing, stale, or unbound
provider option IDs must stay explicitly unmapped even when their labels or
amounts resemble local rows. Confirm the authoritative provider payment total
appears separately from the option subtotals.

Reprocess the same payment and verify that it does not duplicate purchase groups
or tickets. Its authoritative `totalCents`, `refundedCents`, and `netCents`
refresh, and the registration recomputes its gross, refunded, and net aggregates,
but the payment's first persisted mapped/unmapped option groups must not change
after a live binding edit. If testing a deliberate second payment for the same
registration, verify that its identity, groups, subtotals, unmapped items, and
money fields append without replacing the first purchase; aggregates count each
distinct payment exactly once.

### 5. Validate the buyer confirmation

The first successful activation or ticket projection sends one buyer email with
the event and flow, organization/group when present, participant or ticket count,
net payment amount, and secure check-registration link. The link URL uses the
public event slug while its token binds the internal event document id.
Re-deliver or re-sync the same payment and verify that no duplicate confirmation
is queued.
An unmatched group/standard payment must not produce a message that claims a
registration completed.

The four readiness indicators are independent:

| Indicator | Ready condition |
| --- | --- |
| Connection | The site can authenticate to Zeffy and read campaigns. |
| Campaign mapping | The current flow has one selected campaign. |
| Webhook secret | The site stores the token hash; the exact token-bearing URL is visible only immediately after generation/rotation. |
| Last accepted webhook | A succeeded payment callback authenticated, was re-fetched, and finished ingestion at the displayed time. |

## Reconcile payments in the registrations workspace

Open `/admin/hosted-events/:eventSlug/registrations` through **View
registrations** in the event's existing cog menu. This workspace brings together completed and
pending submissions, unlinked Zeffy entries with ranked suggestions, verified
payment-link inquiries, and refund requests. Provider information and every
association mutation are available only to staff who have both the hosted-event
and payment-management authority.

Use this sequence for an unlinked payment:

1. Confirm that Zeffy reports the payment succeeded and has not been refunded.
2. Confirm the campaign, event, year, flow, and permitted payment window.
3. Inspect the payment's authoritative total and every provider line item before
   association. Confirm which items resolve by exact provider option ID and which
   are explicitly unmapped against the current mapped flow; never treat a similar
   label or amount as a match. This generic preview does not borrow an arbitrary
   registration snapshot before staff chooses a registration.
4. Inspect the ranked suggestions. A one-character email difference or an exact
   normalized structured full-name match can rank a same-event registration,
   but neither is an association.
5. Look for a verified inquiry when the purchaser says they used another email.
   Verification proves control of that alternate address; it does not prove
   which registration or payment should be linked.
6. Explicitly confirm the intended association. The server rechecks provider
   state, scope, payment window, and existing associations transactionally. If
   anything changed while the workspace was open, reload and resolve the new
   state instead of bypassing the refusal. Confirmation resolves options again
   against the selected registration's immutable flow snapshot and persists that
   historical result, so it can legitimately differ from a current-flow preview.

Never confirm from name similarity, email similarity, amount, receipt identity,
or checkout-handle possession alone. Exact normalized provider email equal to
the normalized linking email is the only automatic link. Every non-exact-email
association remains a staff decision even when the suggestion appears first.
After staff confirmation, verify the registration has the same purchase result
as an automatic exact-email association: payment identity, exact-ID option
groups, unmapped items, per-payment gross/refunded/net values, registration
aggregates, and any provider-backed invoice are recorded together. Reconfirming
the same payment uses the same monetary-refresh and immutable-option rules as an
automatic replay.

For a stale or unbound local option, fix future configuration in the flow editor
only after verifying the exact Zeffy option. Historical provider line items stay
unmapped unless their saved exact IDs establish a binding; do not rewrite them
by label or amount. Reconciliation associates a payment with a registration—it
does not guess or mutate option bindings.

If the purchaser selects **I paid with a different email**, they enter the email
used at Zeffy and receive the same generic response whether or not a payment can
be found. Requests are rate-limited. When eligible, a short-lived one-time link
is sent only to that alternate address and opens the event's
`/events/:eventSlug/payment-inquiry` page. The link creates or updates one
event/year/flow-scoped inquiry for review; it never links the payment directly.
Expired, replayed, altered, wrong-event, and invalid links show one data-free
unavailable response and cannot create duplicate inquiries.

## Support ticket delivery and purchaser self-service

Each succeeded Zeffy ticket item should produce one Band Boosters ticket with
its distinct provider item identity, exact option ID and resolved local label
when bound, occurrence when supplied, resolvable event date, and one stable
unique check-in code. Re-syncing a payment must not
duplicate its tickets or replace their codes. When one registration has
multiple additive provider payments, tickets from all those payment identities
must be present in lookup. A grouped option quantity enriches the registration
summary; it never collapses distinct ticket records.

Treat option binding as purchase-description metadata, not new authority.
Existing privacy and capability checks, exact-email rules, refund processing,
account entitlement, ticket grants, and mobile-wallet behavior remain unchanged.

Ticket email uses the dedicated `ticket_access` template in the normal message
pipeline. Its **View my tickets** link uses the configured public origin, never
a hard-coded domain, and carries a random revocable grant rather than a payment
or registration id. Before a mismatched payment is linked, send ticket access
only to the Zeffy/provider address. After staff verifies the link, reuse the same
grant for the linking address and provider address when they differ. Normalize
recipients, provider retries, and deliveries so the same person or callback does
not receive duplicate grants or messages.

If either verified address maps to an existing student or parent account, the
tickets should also appear in that account's standard ticket dashboard and
day-of links view under the existing authorization rules. Do not remove guest
grant access merely because account assignment succeeds.

Use the grant's `/tickets/<opaque-grant>` wallet to support a guest. It is a
private, no-store, noindex mobile view with one ticket per page, previous/next
and position controls, ticket label, attendee, status, and check-in code. An
invalid, expired, revoked, altered, or wrong-purpose grant reveals no ticket,
payment, registration, or email data. Ticket grants are separate from the older
short-lived registration-access links; the older links remain read-only.

After payment is linked, the wallet shows effective custom registration answers
as a read-only form. An accessible edit icon appears only for a custom answer
captured in the registration's saved flow snapshot. The purchaser can edit that
field with explicit save/cancel states; field-type validation, version checking,
and audit history still apply. Provider re-sync must preserve purchaser
overrides. The linking email, ticket identity/type/count, payment and refund
state, provider data, internal identifiers, and other system values are never
editable through the grant.

**Request a refund** opens one staff-reviewed request and may include purchaser
context. The confirmation must say that no automatic refund occurred. A pending
request does not invalidate tickets or mark the payment refunded, and a second
active request for the same payment is refused. Process the refund manually in
the provider workflow; only the provider's actual refund update changes payment
and ticket validity.

## Control public discovery

The flow switches answer different questions:

| Enabled | Show publicly | Result |
| --- | --- | --- |
| No | No or yes | Direct URL is unavailable and the flow is not advertised. |
| Yes | No | Direct URL works, but the public event page does not reveal the flow. |
| Yes | Yes | Direct URL works and the public event page shows the configured label. |

Use enabled-but-hidden for invitation-only or staged registrations. Use
disabled to close a flow. Do not hide a flow as a substitute for closing it.

Disabling the parent hosted event closes every flow as well. Direct URLs do not
bypass the event lifecycle, and archived event pages do not advertise the flow
or registration-check actions.

The public event page orders advertised actions by the flow list. Each
equal-height card uses its full surface as the primary flow link and keeps its
visual call to action aligned at the bottom. When recovery is enabled, its link
remains a separate keyboard-operable sibling rather than a nested control.
Review primary and recovery activation at desktop and narrow mobile widths after
changing labels, pricing copy, or order.

## Configure recovery actions

Each flow independently controls **Show recovery action**. Group and standard
flows label that action **Check your registration**; ticket flows label it
**View your tickets**. Both open:

```text
/events/:eventSlug/check-registration
```

This page requests only the contact email. It does not expose registration IDs,
direct confirmation URLs, or hidden flow links. On the event page, recovery is
shown only for a publicly visible flow with the setting enabled. On a flow's
enabled direct page, the setting still applies when that flow is hidden from
event-page discovery.

After an email is submitted, the visitor always sees the same generic message.
For every valid enabled-event request, the production web handler writes the
same recipient-free record to the durable mail outbox without checking whether
the address matches. It therefore does not hold the anonymous request open for
database matching or SMTP. Immediately before delivery, the Functions worker
privately checks the event year and normalized email. It completes unmatched
requests without a recipient; for matches, it creates the expiring opaque link
and turns the outbox record into a normal one-recipient announcement. The link
shows a read-only confirmation of all registrations and tickets for that event
year and contact email, regardless of which flow advertised recovery, including
an owner-visible awaiting-payment state when a payment-gated submission is not
yet active. The encrypted token binds the email without exposing it as plaintext
in the URL. Confirmation responses are private/no-store, and ticket summaries
are checked against provider, event slug, and year. Guests cannot edit or cancel
from this older registration-access link. Eligible custom-answer edits and
refund requests require the separate ticket grant described above; a refund
remains a staff-reviewed request, not a direct cancellation or provider mutation.

Support staff must not use differences in the request response to confirm that
an address is registered. If a guest does not receive mail, verify the spelling,
ask them to retry, and inspect the normal mail-delivery tooling with appropriate
staff access. Never send an internal registration identifier as a replacement.

## Interpret invoices, rosters, and exports

An immediate manual or non-Zeffy invoice outcome stores the allocated invoice
identity on the registration so the Admin roster and export join the exact
invoice. A Zeffy-owned pending invoice flow does not create or email an invoice
from a local configured-price guess. After association, any resulting internal
paid invoice uses the provider payment identity and authoritative total. On
first projection and later replay, provider-created invoices retain the gross
charge, refunded amount, and net amount still held; a full refund changes their
status to `refunded` instead of leaving them `paid`.
Manual/check invoice reconciliation keeps using the established invoice status
and check-number workflow.

Every submitted group or standard registration and every projected ticket
purchase saves an immutable `flowSnapshot` with the selected flow's `id`,
`slug`, `label`, mechanical `kind`, reusable `fields`, and ordered `prices`,
including the saved Zeffy option bindings required to explain historical
purchases.
Enablement, visibility, outcome, payment, and checkout settings remain live
configuration and are not part of the snapshot.

Each distinct entry in `providerPurchases` retains `providerPaymentId`, gross
`totalCents`, optional `refundedCents` and `netCents`, and its immutable resolved
option groups. Registration-level `providerTotalCents`,
`providerRefundedTotalCents`, and `providerNetTotalCents` sum those distinct
payments for invoice and administration use. Same-payment replay refreshes the
three monetary values without re-resolving saved option groups; a new payment
appends before all three aggregates are recomputed.

The Admin roster and CSV export interpret each row from its snapshot, so one
event can contain group, standard, and ticket rows with different schemas and
price labels. Pending rows may remain excluded from completed-registration
exports. Included paid rows export resolved purchased option labels, quantities,
subtotals, explicit unmapped state when applicable, and the authoritative
provider total; the saved snapshot separately retains the exact binding used to
derive that historical meaning. Exports do not report every configured price as
purchased. Editing, repricing, unbinding, hiding, or deleting a live flow does
not reinterpret existing registrations. Legacy rows without snapshots continue
to use the year-wide legacy schema and invoice association.

Cloning a year deep-copies its complete nested fields, price rows, and checkout
mapping. Review dates, fees, links, and provider campaigns in the new year; the
prior year's configuration and saved snapshots remain unchanged.

## Configure Drumline Festival

For the current Drumline Festival year:

1. Create **Register your group** as a `group` flow.
2. Set its outcome to `invoice`; configure required organization, ensemble,
   director, phone, and billing fields; and add any participant/event questions.
   Keep the seeded zero-dollar Group registration price per line or replace it
   with the intended effective fee.
3. Enable it. Show it publicly only when public discovery is wanted; otherwise
   distribute its copied direct URL.
4. Create **Purchase tickets** as a `tickets` flow.
5. Configure the General ($12), Student / senior / military ($7), and Family
   ($25) price rows and `manual` checkout as the initial fallback.
6. After Zeffy is connected and the correct campaign exists, explicitly switch
   the ticket flow to `zeffy` and map that campaign. Use the same mapping
   experience if the group flow will require payment before registration.
7. Choose recovery visibility separately on both flows. The group action reads
   **Check your registration** and the ticket action reads **View your tickets**.
8. Test both flows anonymously and request a confirmation link using a test
   contact address before distributing links.

The idempotent seed persists these two complete canonical flows on the 2026 year
document. Each row owns `prices`, public-pricing copy/visibility, and recovery
visibility; the group owns reusable fields and no row stores `registrantType`.
The seeded ticket checkout is the manual `https://grizzlyband.org` fallback.
Running the seed again preserves that declared launch configuration by
reapplying it, including manual checkout.
Do not rerun the seed after selecting a Zeffy campaign unless restoring those
seed defaults is intended; campaign selection remains an explicit admin
operation.

## Pre-publish check

- Every flow has the intended kind, label, stable slug, order, and enabled
  state.
- Public visibility matches the desired discovery policy.
- Each flow's recovery visibility is intentional, with the expected
  kind-specific action label and one event-wide email result.
- Each flow uses the shared ordered price editor. Group/standard dated and
  undated rows display in the intended order and ticket rows display the
  intended options.
- A Zeffy-backed form shows a read-only **Available at checkout** list, explains
  that type and quantity are selected on Zeffy, and has one final local submit.
  Missing required answers announce adjacent accessible errors without a
  request; no local price or quantity intent is posted.
- **Allow multiple (supported providers only)** persists on intended price rows
  but does not change Zeffy, which has no hosted-session prefill endpoint.
- Group and standard flows show the intended `invoice` or `confirmation`
  outcome.
- Every payment-required group or standard flow has the intended Zeffy campaign
  and returns pending—not completed—before the callback arrives.
- Every mapped local price labels its selector **Zeffy checkout option**, retains
  the intended exact ID after reload, visibly distinguishes bound, unbound, and
  stale states, and rejects duplicate non-empty IDs within the flow.
- A pending Zeffy-owned row says **Payment pending**, shows no selected option or
  known amount, sends no guessed-price invoice, and offers no action that
  completes payment outside Zeffy. Manual and non-Zeffy invoice behavior is
  unchanged.
- A custom per-price URL is not treated as enough configuration for missed-
  webhook reconciliation; the flow has an exact mapped Zeffy campaign.
- **Save mapping** completed successfully and reload still shows **Currently
  mapped** for the intended campaign; no second settings-save step is required.
- Current group and standard forms contain only the intended required reusable
  fields, with no registrant-type selector or hidden kind-derived requirements.
- Every Name question renders separately labelled First name and Last name
  controls. Required names reject a missing part; optional names accept both
  blank but reject a partial value. Details, CSV, snapshots, and confirmation
  preserve both parts, while legacy strings remain readable.
- Select fields that should accept a custom response have **Allow custom Other
  entry** enabled.
- Ticket flows clearly show `manual` or the selected Zeffy campaign.
- Mapping is available on every flow when Zeffy is connected; a disconnected
  integration explains the prerequisite and does not offer a usable mapping
  action.
- The walkthrough reports connection, current-flow mapping, webhook-secret
  configuration, and last accepted webhook independently.
- The one-time token-bearing **Exact callback URL** has been installed in Zeffy,
  and **Last accepted webhook** proves one fully processed completed-payment
  delivery rather than merely secret creation.
- Removing a Zeffy binding makes the campaign available elsewhere and does not
  resurrect a legacy target after reload.
- Copied direct URLs work for enabled flows; hidden flows do not appear on the
  public event page.
- Each public action card is one full-card primary link with a bottom-aligned
  visual action; an enabled recovery link remains a separate non-nested action
  with independent keyboard focus.
- The check-registration request returns generic copy for matching and
  nonmatching addresses, valid legacy mail links are read-only, and a pending
  payment is visible only to its email owner without being labeled registered.
- A controlled payment sends one buyer confirmation with the secure lookup link;
  retrying the same callback does not send another.
- Paid rows and details show **Purchased option(s)** from exact provider option
  IDs, including quantity, subtotal, and authoritative payment total. Repeated
  exact-ID items group correctly, a bound free option is known `$0.00`, and
  unbound or stale items stay explicitly unmapped without label/amount guessing.
- A distinct second payment for one unambiguous event/year/flow/email match
  appends to `providerPaymentIds`, purchased groups, subtotals, unmapped items,
  and provider totals without replacing the earlier purchase; replay of either
  payment remains idempotent.
- A successful local save shows the submitted-answer confirmation, exact linking
  email and use-at-Zeffy instruction, announced Copy feedback, and one **Pay
  now** action without opening Zeffy or claiming to prefill it.
- **Pay now** uses a popup-style Zeffy context on desktop with current-tab
  fallback; mobile uses the current tab. The URL is selected by the server.
- Refresh, navigation away, and an abandoned Zeffy visit preserve one pending
  same-browser checkout; its conditional header cart returns anonymous and
  signed-in guests to the saved route and clears after paid, invalid, or
  expired status.
- A returned checkout restores the confirmation, answer summary, linking-email
  instruction, Copy action, Pay now, and status without resubmission. Its private
  server response supplies display data; browser storage still contains only
  the opaque handle, expiry, and return route.
- Browser storage contains only the opaque handle, expiry, and return route;
  inspect it during a test to confirm no form or provider personal data leaked.
- Status requests send the handle only as an Authorization bearer;
  it never appears in the return URL or query string. Return reconciliation is
  exact-campaign/email scoped, one-minute throttled, and capped at three pages.
- Only an exact normalized provider/linking-email match auto-links. Ranked name
  and near-email suggestions never associate records until authorized staff
  explicitly confirm and the transaction rechecks provider state and scope.
- Alternate-email requests are rate-limited and non-enumerating; eligible links
  go only to the alternate address, are short-lived and one-time, and create at
  most one scoped inquiry without linking a payment.
- The event cog opens the registrations workspace. Its completed, pending,
  unlinked-payment, verified-inquiry, and refund-request views require the
  established hosted-event and payment-management authority.
- Before association, each reconciliation entry exposes its authoritative total
  and mapped/unmapped line items. An explicit staff link and an automatic exact-
  email link must produce the same purchase record and any applicable provider-
  backed invoice.
- Each provider ticket item has exactly one ticket and stable check-in code;
  re-sync is idempotent and tickets from additive payment ids remain discoverable.
- Ticket delivery uses the configured public origin and dedicated template with
  one revocable opaque grant. Before mismatched linking it goes only to the
  provider email; after staff linking it reaches both distinct verified emails
  without duplicate grants or deliveries.
- Existing student/parent accounts receive their tickets in the normal dashboard
  and day-of links views under existing authorization.
- The private, noindex ticket wallet pages one ticket at a time with controls,
  position, attendee, status, and check-in code. Invalid or revoked grants return
  a data-free unavailable state.
- Linked wallet answers are read-only until an eligible field's accessible edit
  action is used. Saving is snapshot-type validated, version checked, audited,
  and preserved across provider sync; system, payment, email, and ticket fields
  never become editable.
- **Request a refund** creates one active staff-reviewed request and says no
  automatic refund occurred. Tickets remain valid until an actual provider
  refund update arrives.
- Paid completed-registration exports contain the resolved option labels,
  quantities, subtotals, unmapped state, and provider total; their registration
  snapshots retain the exact option binding needed to explain them. Pending rows
  may remain excluded.
- Focused option-binding and purchase-projection tests, the full repository
  check, production container build, independent review, and documentation sync
  all pass before merge.
- Keyboard focus is visible, every action is operable without a pointer, state
  labels do not rely on color, the cart target is at least 44 by 44 CSS pixels,
  state changes are announced, and confirmation, inquiry, reconciliation,
  wallet paging, read-only answers, editing, and refund requests have no
  horizontal overflow or layout-shifting hover effects at 375, 768, 1024, or
  1440 CSS pixels.

## Abuse and duplicate-submission limitation

Registration-access email requests use the production IP rate limiter. The
anonymous group/standard submission endpoint does not currently have its own
rate limit, CAPTCHA, or idempotency key. A repeated valid submit can create a
second registration, invoice, and email. Review apparent duplicates in the
admin registrations list before accounting or scheduling, and do not rely on a
hidden direct URL as an abuse-prevention measure. Zeffy/provider sync has its
own deterministic idempotency and does not share this limitation.

## Compatibility and rollout

An event year where the `registrationFlows` field is absent keeps its existing
behavior. The legacy `/events/:slug/register` URL remains valid, including
year-wide organization/student form adaptation, invoice behavior, custom
questions, registration pricing, ticket URLs, and external registration
options. The legacy Registration type, Unit amount, Registration date pricing,
Ticket prices, and lookup controls are available only in this absent-field mode.

An explicit `registrationFlows: []` is different: it is authoritative and means
the year has no registration or ticket paths. Do not delete the field to express
“none,” because absence intentionally invokes compatibility behavior.

When adopting flows for an existing year, first reproduce its current behavior
as an explicit flow, verify the direct URL and outcome, and only then add new
audiences or hide the legacy-equivalent action. Existing signed-in ownership
summaries remain supported throughout the rollout. The next current Admin save
writes the complete nested array and does not write current `registrationType`
or split year-wide pricing/recovery inputs.

Missing payment-requirement and campaign-mapping properties preserve the prior
behavior. Connecting Zeffy does not silently gate an existing flow. Existing
non-payment group/standard flows, invoice outcomes, manual ticket handoffs,
disconnected sites, and previously stored flow documents therefore continue to
operate without a migration.
