# Checkout-First Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zeffy-owned registration flows stop collecting a form before payment; the buyer buys first, ingestion creates the registration and emails a wallet link, and the buyer finishes required questions in the wallet.

**Architecture:** A provider capability flag marks Zeffy as unable to carry buyer identity, which makes every Zeffy checkout flow "checkout-first". The register page becomes a purchase screen that issues an emailless checkout record and opens Zeffy. The existing return poller runs a campaign-scoped ingest instead of an email-filtered one. Ingestion (already idempotent per provider payment) now also creates group/standard registrations and issues the wallet grant email for them. The wallet gains the unanswered required fields and a `detailsStatus`.

**Tech Stack:** Next.js app router (web/), Firebase Admin Firestore, Vitest, Cloud Functions email templates (functions/).

**Spec:** `docs/superpowers/specs/2026-09-02-checkout-first-registration-design.md`

## Global Constraints

- Every new file carries the copyright header block and a self-contained purpose paragraph (see any existing file header).
- Every exported symbol gets a JSDoc block.
- Test first: write the failing test, run it, implement, run it, commit.
- Run tests from `web/` with `npx vitest run <path>`; the worktree's `web/node_modules` is a symlink to the primary tree.
- Never `git add -A`; add the exact files.
- Copy rules: guest waiting copy is "If you completed your payment, watch your email for next steps. If you didn't, you can go back and purchase." Finish copy uses "finish your registration"; complete copy uses "view your tickets".
- No new dependencies.
- Worktree: `.claude/worktrees/checkout-first`, branch `checkout-first`. All paths below are relative to `web/src/` unless they start with `functions/` or `docs/`.

---

### Task 1: Provider capability flag and `isCheckoutFirstFlow`

**Files:**
- Modify: `lib/payments/registry.ts:20-31` (capabilities interface) and `:92-98` (Zeffy entry)
- Create: `lib/hosted-events/checkout-first.ts`
- Test: `lib/hosted-events/checkout-first.test.ts`

**Interfaces:**
- Produces: `isCheckoutFirstFlow(flow: Pick<HostedEventRegistrationFlow, "checkout"> | undefined): boolean` and `flowRequiresDetails(flow: Pick<HostedEventRegistrationFlow, "fields" | "registrationFields">): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/hosted-events/checkout-first.test.ts
import { describe, expect, it } from "vitest";
import { PAYMENT_PROVIDER_REGISTRY } from "@/lib/payments/registry";
import { flowRequiresDetails, isCheckoutFirstFlow } from "./checkout-first";

describe("isCheckoutFirstFlow", () => {
  it("declares Zeffy unable to carry buyer identity", () => {
    expect(PAYMENT_PROVIDER_REGISTRY.zeffy.capabilities.checkoutCarriesBuyerIdentity).toBe(false);
  });
  it("is true for a Zeffy checkout flow", () => {
    expect(isCheckoutFirstFlow({ checkout: { method: "zeffy", campaignId: "c", url: "https://z" } })).toBe(true);
  });
  it("is false for manual checkout and for no checkout", () => {
    expect(isCheckoutFirstFlow({ checkout: { method: "manual", url: "https://m" } })).toBe(false);
    expect(isCheckoutFirstFlow({})).toBe(false);
    expect(isCheckoutFirstFlow(undefined)).toBe(false);
  });
});

describe("flowRequiresDetails", () => {
  const field = { key: "shirt", label: "Shirt", scope: "buyer" as const, type: "text" as const, options: [] };
  it("is true only when some field is required", () => {
    expect(flowRequiresDetails({ fields: [{ ...field, required: true }] })).toBe(true);
    expect(flowRequiresDetails({ fields: [{ ...field, required: false }] })).toBe(false);
    expect(flowRequiresDetails({ registrationFields: [{ ...field, required: true }] })).toBe(true);
    expect(flowRequiresDetails({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/hosted-events/checkout-first.test.ts`
Expected: FAIL, module `./checkout-first` not found.

- [ ] **Step 3: Implement**

In `lib/payments/registry.ts` add to `PaymentProviderCapabilities` after `refundsViaApi`:

```ts
  /**
   * The platform can hand the buyer's email and answers into checkout, so
   * collecting them before payment is safe. False forces checkout-first flows.
   */
  checkoutCarriesBuyerIdentity: boolean;
```

and in the Zeffy entry add `checkoutCarriesBuyerIdentity: false,`. Update the file header sentence listing capability flags to include "checkout carries buyer identity".

Create `lib/hosted-events/checkout-first.ts`:

```ts
/**
 * Copyright (c) 2026 Band Boosters Platforms. Use of this source code is governed
 * by the LICENSE file in the repository root.
 *
 * Pure predicates deciding whether a hosted-event registration flow is
 * checkout-first: the buyer pays at the provider before any local details are
 * collected because the provider cannot carry buyer identity into checkout.
 * Also reports whether a flow has any required question the buyer must still
 * answer after payment, which drives "finish your registration" copy.
 */
import { PAYMENT_PROVIDER_REGISTRY } from "@/lib/payments/registry";
import type { HostedEventRegistrationFlow } from "./types";

/**
 * Returns whether a flow's checkout happens before local details are collected.
 *
 * @param flow - Flow whose checkout configuration is inspected.
 * @returns True when the checkout provider cannot carry buyer identity.
 */
export function isCheckoutFirstFlow(
  flow: Pick<HostedEventRegistrationFlow, "checkout"> | undefined
): boolean {
  if (flow?.checkout?.method !== "zeffy") return false;
  return !PAYMENT_PROVIDER_REGISTRY.zeffy.capabilities.checkoutCarriesBuyerIdentity;
}

/**
 * Returns whether the buyer must answer at least one required question.
 *
 * @param flow - Flow whose configured fields are inspected.
 * @returns True when any buyer or participant field is required.
 */
export function flowRequiresDetails(
  flow: Pick<HostedEventRegistrationFlow, "fields" | "registrationFields">
): boolean {
  return (flow.fields ?? flow.registrationFields ?? []).some((field) => field.required);
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/lib/hosted-events/checkout-first.test.ts src/lib/payments`
Expected: PASS (registry tests may assert the capability object shape; update any exact-equality fixture to include the new key).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/payments/registry.ts web/src/lib/hosted-events/checkout-first.ts web/src/lib/hosted-events/checkout-first.test.ts
git commit -m "feat: add checkoutCarriesBuyerIdentity capability and checkout-first predicate"
```

---

### Task 2: Reject form submissions for checkout-first flows

**Files:**
- Modify: `lib/hosted-events/registration.ts:531-540` (`submitRegistration` open check)
- Test: `lib/hosted-events/registration.test.ts` (existing file; add a case)
- Test: `app/api/events/[slug]/register/handler.test.ts` (existing; add a case)

**Interfaces:**
- Consumes: `isCheckoutFirstFlow` from Task 1.
- Produces: `submitRegistration` returns `{ ok: false, message: REGISTRATION_DISABLED_MESSAGE }` (no `errors`) for a checkout-first flow, which the handler already maps to 409.

- [ ] **Step 1: Write the failing tests**

In `lib/hosted-events/registration.test.ts` add:

```ts
it("rejects a submission for a checkout-first (Zeffy) flow without persisting", async () => {
  const persistRegistration = vi.fn();
  const result = await submitRegistration(
    {
      event: { ...enabledEvent, status: "enabled" },
      year: baseYear,
      input: validInput,
      flow: {
        ...standardFlow,
        checkout: { method: "zeffy", campaignId: "camp", url: "https://zeffy.test/c" },
      },
    },
    { ...deps, persistRegistration }
  );
  expect(result).toEqual({ ok: false, message: REGISTRATION_DISABLED_MESSAGE });
  expect(persistRegistration).not.toHaveBeenCalled();
});
```

(Use the file's existing fixture names for an enabled event, a base year, a valid input, a standard flow, and the deps object; they exist near the top of the file.)

In `app/api/events/[slug]/register/handler.test.ts` add a case that resolves a flow with `checkout.method === "zeffy"` and asserts the response is 409 with `REGISTRATION_DISABLED_MESSAGE` and that `deps.submit` is not called.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/hosted-events/registration.test.ts "src/app/api/events/[slug]/register/handler.test.ts"`
Expected: FAIL (submission currently persists and returns `paymentPending: true`).

- [ ] **Step 3: Implement**

In `registration.ts` import `isCheckoutFirstFlow` and change the open check in `submitRegistration`:

```ts
  const configuredFlowIsOpen =
    event.status === "enabled" &&
    flow?.enabled === true &&
    (flow.kind === "group" || flow.kind === "standard") &&
    !isCheckoutFirstFlow(flow);
```

In `app/api/events/[slug]/register/handler.ts:286` change the flow guard:

```ts
  if (!flow || flow.kind === "tickets" || isCheckoutFirstFlow(flow)) {
    return Response.json({ error: REGISTRATION_DISABLED_MESSAGE }, { status: 409 });
  }
```

Remove the now-dead `zeffyOwned` branches in `submitRegistration` (`const zeffyOwned`, the `delete persistedInput.selectedPriceId`, the `requiresLocalPriceChoice` Zeffy exclusion, and the `if (zeffyOwned || ...)` early return keeps only the `pendingPayment && flow?.outcome === "confirmation"` condition). Update the file header sentence that describes Zeffy-owned pending submissions. Delete tests in `registration.test.ts` that asserted the old Zeffy pending-submission behavior only if they now contradict; do not delete tests that still hold.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/lib/hosted-events src/app/api/events`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/hosted-events/registration.ts web/src/lib/hosted-events/registration.test.ts "web/src/app/api/events/[slug]/register/handler.ts" "web/src/app/api/events/[slug]/register/handler.test.ts"
git commit -m "feat: reject pre-payment form submissions for checkout-first flows"
```

---

### Task 3: Emailless checkout creation endpoint

**Files:**
- Create: `app/api/events/[slug]/register/checkout/create-handler.ts`
- Modify: `app/api/events/[slug]/register/checkout/route.ts` (add `POST`)
- Modify: `app/api/events/[slug]/register/[flowSlug]/checkout/route.ts` (add `POST`)
- Modify: `app/api/events/[slug]/register/admin.ts:375-413` (`issueCheckout` accepts optional registration/email/confirmation)
- Modify: `app/api/events/[slug]/register/handler.ts` (`RegisterRouteDeps.issueCheckout` arg type: make `registrationId`, `normalizedEmail`, `linkingEmail`, `confirmation` optional)
- Modify: `app/api/events/[slug]/register/checkout/admin.ts:80-84` (`checkoutRecord` no longer requires `registrationId`)
- Test: `app/api/events/[slug]/register/checkout/create-handler.test.ts`

**Interfaces:**
- Produces: `handleCheckoutCreateRequest(slug: string, flowSlug: string | null, deps: CheckoutCreateDeps): Promise<Response>` returning 200 `{ paymentUrl, checkout: { handle, expiresAt, returnPath } }`, 404 unknown event, 409 when the flow is not an enabled checkout-first flow or has no checkout URL.
- `CheckoutCreateDeps = { resolveEvent(slug): Promise<ResolvedEvent | null>; issueCheckout(args: { resolved; flow; paymentUrl; returnPath }): Promise<{ handle; expiresAt; returnPath }> }` where `ResolvedEvent` is the same type `RegisterRouteDeps.resolveEvent` returns in `handler.ts`.
- Checkout documents written with `registrationId: ""`, `normalizedEmail: ""`, no `linkingEmail`, no `confirmation`.

- [ ] **Step 1: Write the failing test**

```ts
// create-handler.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleCheckoutCreateRequest } from "./create-handler";

const flow = {
  id: "f1", slug: "camp", label: "Camp", kind: "standard" as const, enabled: true,
  showOnPublicPage: true, prices: [],
  checkout: { method: "zeffy" as const, campaignId: "camp-1", url: "https://zeffy.test/camp" },
};
const resolved = {
  event: { id: "e1", slug: "band-camp", status: "enabled", kind: "registration", currentYear: 2026 },
  year: { year: 2026, registrationFlows: [flow] },
  timeZone: "America/Chicago",
} as never;

describe("handleCheckoutCreateRequest", () => {
  it("issues an emailless checkout for a checkout-first flow", async () => {
    const issueCheckout = vi.fn().mockResolvedValue({ handle: "h", expiresAt: 5, returnPath: "/events/band-camp/register/camp" });
    const response = await handleCheckoutCreateRequest("band-camp", "camp", {
      resolveEvent: async () => resolved,
      issueCheckout,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      paymentUrl: "https://zeffy.test/camp",
      checkout: { handle: "h", expiresAt: 5, returnPath: "/events/band-camp/register/camp" },
    });
    expect(issueCheckout).toHaveBeenCalledWith(expect.objectContaining({
      paymentUrl: "https://zeffy.test/camp",
      returnPath: "/events/band-camp/register/camp",
    }));
  });
  it("returns 409 for a manual-checkout flow", async () => {
    const manual = { ...resolved, year: { year: 2026, registrationFlows: [{ ...flow, checkout: { method: "manual", url: "https://m" } }] } } as never;
    const response = await handleCheckoutCreateRequest("band-camp", "camp", {
      resolveEvent: async () => manual, issueCheckout: vi.fn(),
    });
    expect(response.status).toBe(409);
  });
  it("returns 404 for an unknown event", async () => {
    const response = await handleCheckoutCreateRequest("nope", "camp", {
      resolveEvent: async () => null, issueCheckout: vi.fn(),
    });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run "src/app/api/events/[slug]/register/checkout/create-handler.test.ts"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`create-handler.ts`:

```ts
/**
 * Copyright (c) 2026 Band Boosters Platforms. Use of this source code is governed
 * by the LICENSE file in the repository root.
 *
 * Dependency-injected HTTP core that starts an anonymous checkout-first
 * purchase. It resolves the event and flow, requires a checkout-first flow with
 * a provider checkout URL, issues an opaque checkout capability that carries no
 * buyer email or answers, and returns the capability with the provider URL so
 * the browser can open checkout and poll for the resulting payment.
 */
import { isCheckoutFirstFlow } from "@/lib/hosted-events/checkout-first";
import { REGISTRATION_DISABLED_MESSAGE } from "@/lib/hosted-events/registration";
import { resolveRegistrationFlow } from "@/lib/hosted-events/registration-flows";
import type { HostedEventRegistrationFlow } from "@/lib/hosted-events/types";
import type { RegisterRouteDeps } from "../handler";

/** Resolved event/year context shared with the register route. */
type ResolvedEvent = NonNullable<Awaited<ReturnType<RegisterRouteDeps["resolveEvent"]>>>;

/** Persistence seams for creating an emailless checkout. */
export interface CheckoutCreateDeps {
  /** Resolves the public event and current year by slug. */
  resolveEvent: RegisterRouteDeps["resolveEvent"];
  /** Issues and persists one opaque checkout capability. */
  issueCheckout(args: {
    resolved: ResolvedEvent;
    flow: HostedEventRegistrationFlow;
    paymentUrl: string;
    returnPath: string;
  }): Promise<{ handle: string; expiresAt: number; returnPath: string }>;
}

/** Returns the provider checkout URL for a checkout-first flow, or null. */
function checkoutUrl(flow: HostedEventRegistrationFlow): string | null {
  if (flow.checkout?.method !== "zeffy") return null;
  return flow.checkout.url || flow.checkout.manualFallbackUrl || null;
}

/**
 * Starts an anonymous checkout-first purchase for one flow.
 *
 * @param slug - Event slug from the route.
 * @param flowSlug - Flow slug from the route, or null for the legacy route.
 * @param deps - Event resolution and checkout persistence.
 * @returns 200 with the checkout capability and provider URL; 404 unknown event; 409 not a checkout-first flow.
 */
export async function handleCheckoutCreateRequest(
  slug: string,
  flowSlug: string | null,
  deps: CheckoutCreateDeps
): Promise<Response> {
  const resolved = await deps.resolveEvent(slug);
  if (!resolved) return Response.json({ error: "event not found" }, { status: 404 });
  const flow = resolveRegistrationFlow(resolved.event, resolved.year, flowSlug);
  const paymentUrl = flow ? checkoutUrl(flow) : null;
  if (
    !flow || !flow.enabled || resolved.event.status !== "enabled" ||
    !isCheckoutFirstFlow(flow) || !paymentUrl
  ) {
    return Response.json({ error: REGISTRATION_DISABLED_MESSAGE }, { status: 409 });
  }
  const returnPath = flowSlug
    ? `/events/${encodeURIComponent(slug)}/register/${encodeURIComponent(flowSlug)}`
    : `/events/${encodeURIComponent(slug)}/register`;
  const checkout = await deps.issueCheckout({ resolved, flow, paymentUrl, returnPath });
  return Response.json({ paymentUrl, checkout }, {
    status: 200,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
```

Check `resolveRegistrationFlow` accepts `null` for the legacy flow (handler.ts calls it with `flowSlug` possibly `null | undefined`; mirror that call exactly).

In `admin.ts` `issueCheckout`, make `registrationId`, `normalizedEmail`, `linkingEmail`, `confirmation` optional and persist `registrationId: registrationId ?? ""`, `normalizedEmail: normalizedEmail ?? ""`, and only spread `linkingEmail`/`confirmation` when defined. Export a `buildCheckoutCreateDeps(): CheckoutCreateDeps` from `admin.ts` returning `{ resolveEvent: <the same resolver used by buildRegisterRouteDeps>, issueCheckout }` (reuse the existing closures; do not duplicate the Firestore write).

In `handler.ts` `RegisterRouteDeps.issueCheckout` argument type: mark the same four properties optional.

In `checkout/admin.ts:84` change the final line of `checkoutRecord` to `return record.eventId && record.flowId ? record : null;`.

Add `POST` to both checkout route files:

```ts
/** Starts an anonymous checkout-first purchase for this flow. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ slug: string; flowSlug: string }> }
): Promise<Response> {
  const disabled = await featureGuardResponse("events");
  if (disabled) return disabled;
  const { slug, flowSlug } = await context.params;
  return handleCheckoutCreateRequest(slug, flowSlug, buildCheckoutCreateDeps());
}
```

(legacy route passes `null` for `flowSlug`). Import `buildCheckoutCreateDeps` from `../admin` (register admin) and `handleCheckoutCreateRequest` from `./create-handler` (or `../../checkout/create-handler`). Route files must export only handlers plus `runtime`.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run "src/app/api/events/[slug]/register"`
Expected: PASS, including the existing `checkout/admin.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/api/events/[slug]/register/checkout/create-handler.ts" "web/src/app/api/events/[slug]/register/checkout/create-handler.test.ts" "web/src/app/api/events/[slug]/register/checkout/route.ts" "web/src/app/api/events/[slug]/register/[flowSlug]/checkout/route.ts" "web/src/app/api/events/[slug]/register/admin.ts" "web/src/app/api/events/[slug]/register/handler.ts" "web/src/app/api/events/[slug]/register/checkout/admin.ts"
git commit -m "feat: emailless checkout creation for checkout-first flows"
```

---

### Task 4: `detailsStatus` derivation

**Files:**
- Create: `lib/hosted-events/registration-details.ts`
- Modify: `lib/hosted-events/registration.ts:167` (export `validateCustomFields` wrapper)
- Test: `lib/hosted-events/registration-details.test.ts`

**Interfaces:**
- Produces: `type RegistrationDetailsStatus = "complete" | "incomplete"`; `registrationDetailsStatus(registration: Record<string, unknown>): RegistrationDetailsStatus` reading `flowSnapshot.fields`, top-level reserved keys, `customFields`, `participants`, and `responseOverrides` (selectors `buyer:<key>` and `participant:<i>:<key>` as used by `app/api/tickets/[grant]/admin.ts` `registrationAnswer`). Registrations without a flow snapshot are `complete`.
- `validateRegistrationDetails(input: RegistrationInput, fields: RegistrationCustomField[]): RegistrationErrors` exported from `registration.ts` (custom-field validation only, no email rule).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { registrationDetailsStatus } from "./registration-details";

const snapshot = (fields: object[]) => ({ id: "f", slug: "f", label: "F", kind: "standard", prices: [], fields });
const shirt = { key: "shirt", label: "Shirt", scope: "buyer", type: "select", required: true, options: ["S", "M"] };
const allergies = { key: "allergies", label: "Allergies", scope: "participant", type: "text", required: true, options: [] };

describe("registrationDetailsStatus", () => {
  it("is complete without a snapshot", () => {
    expect(registrationDetailsStatus({})).toBe("complete");
  });
  it("is incomplete when a required buyer field is blank", () => {
    expect(registrationDetailsStatus({ flowSnapshot: snapshot([shirt]), customFields: {} })).toBe("incomplete");
    expect(registrationDetailsStatus({ flowSnapshot: snapshot([shirt]), customFields: { shirt: "M" } })).toBe("complete");
  });
  it("honors purchaser overrides", () => {
    expect(registrationDetailsStatus({
      flowSnapshot: snapshot([shirt]), customFields: {}, responseOverrides: { "buyer:shirt": "S" },
    })).toBe("complete");
  });
  it("requires a participant when a participant field is required", () => {
    expect(registrationDetailsStatus({ flowSnapshot: snapshot([allergies]), participants: [] })).toBe("incomplete");
    expect(registrationDetailsStatus({
      flowSnapshot: snapshot([allergies]), participants: [{ name: "Ana", fields: { allergies: "none" } }],
    })).toBe("complete");
    expect(registrationDetailsStatus({
      flowSnapshot: snapshot([allergies]), participants: [{ name: "Ana", fields: {} }],
      responseOverrides: { "participant:0:allergies": "none" },
    })).toBe("complete");
  });
  it("treats a reserved buyer key on the top level as answered", () => {
    const director = { key: "director", label: "Director", scope: "buyer", type: "text", required: true, options: [] };
    expect(registrationDetailsStatus({ flowSnapshot: snapshot([director]), director: "Pat" })).toBe("complete");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/hosted-events/registration-details.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

In `registration.ts` add after `validateCustomFields`:

```ts
/**
 * Validates only the configured custom questions of a registration, without the
 * event-wide email rule, for post-payment completeness checks.
 *
 * @param input - Registration answers to validate.
 * @param fields - Immutable snapshotted field schema.
 * @returns Field-keyed error messages; empty when every required answer is present.
 */
export function validateRegistrationDetails(
  input: RegistrationInput,
  fields: RegistrationCustomField[]
): RegistrationErrors {
  const errors: RegistrationErrors = {};
  validateCustomFields(undefined, input, errors, {
    fields,
  } as HostedEventRegistrationFlow);
  return errors;
}
```

Create `registration-details.ts`:

```ts
/**
 * Copyright (c) 2026 Band Boosters Platforms. Use of this source code is governed
 * by the LICENSE file in the repository root.
 *
 * Derives whether a stored hosted-event registration has every required answer
 * its immutable flow snapshot demands. It merges buyer-level answers (reserved
 * top-level keys and custom fields), participant rows, and purchaser wallet
 * overrides into one input and reuses the registration validator, so the
 * "details pending" state shown to buyers and staff cannot drift from what the
 * registration form itself would have required.
 */
import {
  validateRegistrationDetails,
  type RegistrationInput,
} from "./registration";
import type {
  HostedEventRegistrationFlowSnapshot,
  RegistrationCustomFieldValue,
} from "./types";

/** Whether a paid registration still needs required answers. */
export type RegistrationDetailsStatus = "complete" | "incomplete";

/** Reads a plain object map, defaulting to empty. */
function objectMap(value: unknown): Record<string, RegistrationCustomFieldValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, RegistrationCustomFieldValue>)
    : {};
}

/** Reads a string, defaulting to empty. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Builds the effective registration input from a stored document, applying
 * wallet overrides keyed by `buyer:<key>` and `participant:<index>:<key>`.
 *
 * @param registration - Raw `event_registrations` document data.
 * @returns Input in the shape the registration validator consumes.
 */
export function effectiveRegistrationInput(
  registration: Record<string, unknown>
): RegistrationInput {
  const overrides = objectMap(registration.responseOverrides);
  const custom = { ...objectMap(registration.customFields) };
  const reserved = {
    schoolName: str(registration.schoolName),
    ensembleNames: str(registration.ensembleNames),
    director: str(registration.director),
    phone: str(registration.phone),
    billingAddress: str(registration.billingAddress),
  };
  for (const [selector, value] of Object.entries(overrides)) {
    const [scope, key] = selector.split(":");
    if (scope !== "buyer") continue;
    if (key in reserved && typeof value === "string") {
      reserved[key as keyof typeof reserved] = value;
    } else {
      custom[key] = value;
    }
  }
  const participants = (Array.isArray(registration.participants) ? registration.participants : [])
    .map((participant, index) => {
      const row = participant && typeof participant === "object"
        ? (participant as Record<string, unknown>)
        : {};
      const fields = { ...objectMap(row.fields) };
      let name = str(row.name);
      for (const [selector, value] of Object.entries(overrides)) {
        const [scope, position, key] = selector.split(":");
        if (scope !== "participant" || Number(position) !== index) continue;
        if ((key === "name" || key === "studentName") && typeof value === "string") name = value;
        else fields[key] = value;
      }
      return { name, fields };
    });
  return {
    ...reserved,
    email: str(registration.email),
    comments: str(registration.comments),
    participants,
    customFields: custom,
  };
}

/**
 * Reports whether every required snapshotted question has an answer.
 *
 * @param registration - Raw `event_registrations` document data.
 * @returns `complete` when nothing required is missing or no snapshot exists.
 */
export function registrationDetailsStatus(
  registration: Record<string, unknown>
): RegistrationDetailsStatus {
  const snapshot = registration.flowSnapshot as Partial<HostedEventRegistrationFlowSnapshot> | undefined;
  if (!snapshot || !Array.isArray(snapshot.fields)) return "complete";
  const errors = validateRegistrationDetails(
    effectiveRegistrationInput(registration),
    snapshot.fields
  );
  return Object.keys(errors).length === 0 ? "complete" : "incomplete";
}
```

Check `RegistrationParticipant` in `registration.ts` for the exact participant shape (`name`, `fields`, optional `studentId`) and match it.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/lib/hosted-events`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/hosted-events/registration.ts web/src/lib/hosted-events/registration-details.ts web/src/lib/hosted-events/registration-details.test.ts
git commit -m "feat: derive registration detailsStatus from snapshot and overrides"
```

---

### Task 5: Ingestion creates checkout-first group/standard registrations and stamps `detailsStatus`

**Files:**
- Modify: `app/api/admin/payments/_shared/registration-sync-store.ts:340-395` (`applyPaymentToLocalRegistration`), `:708-765` (`registrationDocument`), and the pending-to-paid `tx.update` at `:449-461`
- Test: `app/api/admin/payments/_shared/registration-sync-store.test.ts` (existing; add cases)

**Interfaces:**
- Consumes: `registrationDetailsStatus` from Task 4; `isCheckoutFirstFlow` from Task 1.
- Produces: for a checkout-first group/standard flow with no matching pending registration, a new `event_registrations/<providerPaymentId>` document with `flowKind: event.flow.kind`, `paymentStatus: "paid"`, `detailsStatus`, and the buyer confirmation enqueued exactly as the ticket path does. Every registration written or activated by this store carries `detailsStatus`.

- [ ] **Step 1: Write the failing tests**

Add to the existing store test file, using its Firestore harness and fixtures:

```ts
it("creates a paid registration for a checkout-first standard flow with no pending row", async () => {
  // Arrange a hosted event whose year has a standard flow with
  // checkout: { method: "zeffy", campaignId: "camp", url: "https://z" } and one
  // required buyer field { key: "shirt", required: true }, and a campaign link
  // targeting that flow. Seed NO event_registrations.
  const result = await syncRegistrationForPayment(record, link);
  expect(result.created).toBe(true);
  const doc = await db.collection("event_registrations").doc(record.id).get();
  expect(doc.get("flowKind")).toBe("standard");
  expect(doc.get("paymentStatus")).toBe("paid");
  expect(doc.get("detailsStatus")).toBe("incomplete");
  expect(doc.get("email")).toBe(record.payment.buyer.email);
  const outbox = await db.collection("outbox").doc(`hosted-event-payment-${record.id}`).get();
  expect(outbox.exists).toBe(true);
});

it("replays the same payment onto the created registration without duplicating", async () => {
  await syncRegistrationForPayment(record, link);
  const second = await syncRegistrationForPayment(record, link);
  expect(second.created).toBe(false);
  const all = await db.collection("event_registrations").get();
  expect(all.size).toBe(1);
});

it("still activates a legacy pending registration matched by email", async () => {
  // Seed one pending registration with normalizedContactEmail equal to the buyer email.
  const result = await syncRegistrationForPayment(record, link);
  expect(result.created).toBe(false);
  const doc = await db.collection("event_registrations").doc(pendingId).get();
  expect(doc.get("paymentStatus")).toBe("paid");
  expect(doc.get("detailsStatus")).toBe("complete");
});
```

Fill the arrange blocks with the file's existing seeding helpers (look at how the current "activates pending" test seeds `hosted_events`, `years`, and `campaign_links`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/api/admin/payments/_shared/registration-sync-store.test.ts`
Expected: the first two FAIL (`registrationId: null`, no document).

- [ ] **Step 3: Implement**

In `applyPaymentToLocalRegistration`, replace the `if (registrations.length !== 1)` early return with:

```ts
    if (registrations.length > 1) {
      return { registrationId: null, created: false, invoiceNumber: null };
    }
    if (registrations.length === 0) {
      if (!isCheckoutFirstFlow(event.flow ?? undefined)) {
        return { registrationId: null, created: false, invoiceNumber: null };
      }
      return createCheckoutFirstRegistration(tx, db, record, draft, event);
    }
```

Add the helper below `applyPaymentToLocalRegistration`:

```ts
/**
 * Creates the paid registration a checkout-first purchase represents. The
 * document id is the staged provider payment id so a replay finds it through
 * the `alreadyActivated` scan instead of creating a twin.
 */
async function createCheckoutFirstRegistration(
  tx: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  record: ProviderPaymentRecord,
  draft: RegistrationDraft,
  event: Parameters<typeof applyPaymentToLocalRegistration>[2]
): Promise<RegistrationSyncResult> {
  const ref = db.collection(EVENT_REGISTRATIONS).doc(draft.providerPaymentId);
  const invoiceNumber = await allocateRegistrationInvoiceNumber<FirebaseFirestore.DocumentReference>(
    {
      async get(counterRef) {
        const counter = await tx.get(counterRef);
        const value = counter.exists
          ? (counter.data() as { value?: number } | undefined)?.value
          : undefined;
        return typeof value === "number" ? { exists: true, value } : { exists: false, value: 0 };
      },
      set(counterRef, value) {
        tx.set(counterRef, { value }, { merge: true });
      },
    },
    (id) => db.collection(REGISTRATION_COUNTER_COLLECTION).doc(id),
    event.eventCode,
    draft.year
  );
  const document = registrationDocument(draft, event, invoiceNumber);
  tx.set(ref, {
    ...document,
    normalizedContactEmail: draft.email.trim().toLowerCase(),
    provider: record.provider,
    paidAtMs: draft.paidAtMs,
    paidAt: new Date(draft.paidAtMs),
  });
  if (event.canEnqueueConfirmation) {
    await enqueuePaymentConfirmation(tx, db, draft, event, ref.id);
  }
  tx.set(db.collection(EVENT_INVOICES).doc(invoiceNumber), {
    number: invoiceNumber,
    eventId: event.id,
    eventCode: event.eventCode,
    ...invoiceAmounts(draft),
    registrant: { schoolName: draft.contactName, email: draft.email, billingAddress: "" },
    paidAtMs: draft.paidAtMs,
    externalRef: draft.providerPaymentId,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { registrationId: ref.id, created: true, invoiceNumber };
}
```

In `registrationDocument`, replace `flowKind: "tickets"` with `flowKind: event.flow?.kind ?? "tickets"`, and add `detailsStatus` computed from the document itself:

```ts
  const document = { /* existing fields */ };
  return { ...document, detailsStatus: registrationDetailsStatus(document) };
```

In the pending-to-paid `tx.update` (around line 449) add `detailsStatus: registrationDetailsStatus(registrationData)`.

Import `isCheckoutFirstFlow` and `registrationDetailsStatus`. Update the file header to say the store also creates checkout-first group/standard registrations.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/app/api/admin/payments src/lib/payments`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/admin/payments/_shared/registration-sync-store.ts web/src/app/api/admin/payments/_shared/registration-sync-store.test.ts
git commit -m "feat: create checkout-first registrations on payment ingestion with detailsStatus"
```

---

### Task 6: Wallet grant email for every checkout-first registration, status-aware copy

**Files:**
- Modify: `app/api/admin/payments/_shared/ticket-access-delivery.ts:135-190` (`ensureTicketAccessDelivery`)
- Modify: `app/api/admin/integrations/payments/[provider]/sync/deps.ts:556-604` (`projectRegistration` issues the grant for group/standard flows)
- Modify: `functions/src/delivery/templates/ticket-access.ts`
- Test: `app/api/admin/payments/_shared/ticket-access-delivery.test.ts` (existing; add cases)
- Test: `functions/src/delivery/templates/ticket-access.test.ts` (create if absent)

**Interfaces:**
- Produces: `ensureTicketAccessDelivery(record, link, tickets, options?: { registrationId?: string | null; needsDetails?: boolean })`. With zero tickets it proceeds when a registration id resolves. Outbox data becomes `{ eventName, walletUrl, needsDetails }` with no `category` (transactional default).
- `renderTicketAccess` with `needsDetails: true` renders subject `Finish your registration for <event>` and button `Finish my registration`; otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

Delivery test additions:

```ts
it("issues a grant and email for a registration with no tickets", async () => {
  // record with buyer email; seed event_registrations/<record.id> with providerPaymentId: record.id
  await ensureTicketAccessDelivery(record, link, [], { needsDetails: true });
  const issuance = await db.collection("ticket_access_issuances").doc(`registration_${record.id}`).get();
  expect(issuance.exists).toBe(true);
  const outbox = await db.collection("outbox").doc(`ticket-access-registration_${record.id}`).get();
  expect(outbox.get("data.needsDetails")).toBe(true);
  expect(outbox.get("category")).toBeUndefined();
});
it("still skips when there are no tickets and no linked registration", async () => {
  await ensureTicketAccessDelivery(record, link, []);
  const grants = await db.collection("ticket_access_grants").get();
  expect(grants.size).toBe(0);
});
```

(Use the collection constants the file defines: `ISSUANCES`, `GRANTS`.)

Template test:

```ts
import { describe, expect, it } from "vitest";
import { renderTicketAccess } from "./ticket-access";

describe("renderTicketAccess", () => {
  it("asks the buyer to finish registration when details are needed", () => {
    const out = renderTicketAccess({ eventName: "Band Camp", walletUrl: "https://x/tickets/abc", needsDetails: true });
    expect(out.subject).toBe("Finish your registration for Band Camp");
    expect(out.text).toContain("Finish my registration: https://x/tickets/abc");
    expect(out.html).toContain("Finish my registration");
  });
  it("keeps the ticket wording otherwise", () => {
    const out = renderTicketAccess({ eventName: "Band Camp", walletUrl: "https://x/tickets/abc" });
    expect(out.subject).toBe("Your tickets for Band Camp");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/api/admin/payments/_shared/ticket-access-delivery.test.ts` and `cd functions && npx vitest run src/delivery/templates/ticket-access.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ensureTicketAccessDelivery`:

```ts
export async function ensureTicketAccessDelivery(
  record: ProviderPaymentRecord,
  link: CampaignLink,
  tickets: Ticket[],
  options: { needsDetails?: boolean } = {}
): Promise<void> {
  if (!record.payment.buyer.email) return;
  const db = getFirestore(adminApp());
  const registrationId = await linkedRegistrationId(record);
  if (tickets.length === 0 && !registrationId) return;
  // ...unchanged through the transaction, except the outbox message:
      buildOutboxMessage({
        templateId: "ticket_access",
        data: { eventName: event.eventName, walletUrl, needsDetails: options.needsDetails === true },
        recipients: recipients([record.payment.buyer.email]),
        siteOrigin: origin,
      })
```

Remove `category: "announcements"` from BOTH `buildOutboxMessage` calls in this file (the linked-delivery one too). Update the header to say the wallet email is transactional and status-aware.

In `sync/deps.ts` `projectRegistration`:

```ts
        async projectRegistration(link, record) {
          const result = await syncRegistrationForPayment(record, link);
          const flowKind = /* resolve as projectTickets does: */ campaignLinkTargets(link)
            .find((t) => t.kind === "hosted-event-year")?.registrationFlowKind;
          if (result.registrationId && (flowKind === "group" || flowKind === "standard")) {
            const registration = await db.collection("event_registrations").doc(result.registrationId).get();
            await ensureTicketAccessDelivery(record, link, [], {
              needsDetails: registration.get("detailsStatus") === "incomplete",
            });
          }
        },
```

If `registrationFlowKind` is not on the target for this link, fall back to the flow kind from `syncRegistrationForPayment`'s resolved event; if that is not exposed, extend `RegistrationSyncResult` with `flowKind?: HostedEventRegistrationFlowKind` and set it in both branches of `syncRegistrationForPayment`. Also pass `needsDetails` in `projectTickets` by reading the registration the same way when `registrationId` is linked (ticket flows have no required fields today, so `false` is acceptable there; do the read anyway for consistency).

Template:

```ts
  const needsDetails = data.needsDetails === true;
  const subject = needsDetails
    ? `Finish your registration for ${eventName}`
    : `Your tickets for ${eventName}`;
  const action = needsDetails ? "Finish my registration" : "View my tickets";
  const lead = needsDetails
    ? `Your payment for ${eventName} is complete. A few required details are still needed to finish your registration.`
    : `Your tickets for ${eventName} are ready.`;
  const text = `${lead}\n\n${action}: ${walletUrl}\n`;
  // html: same structure, use `lead`, `action`
```

Update the template header. Ensure `functions` build passes: `npm --prefix functions run build`.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/app/api/admin` ; `cd functions && npx vitest run src/delivery && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/admin/payments/_shared/ticket-access-delivery.ts web/src/app/api/admin/payments/_shared/ticket-access-delivery.test.ts "web/src/app/api/admin/integrations/payments/[provider]/sync/deps.ts" web/src/app/api/admin/payments/_shared/registration-sync-store.ts functions/src/delivery/templates/ticket-access.ts functions/src/delivery/templates/ticket-access.test.ts
git commit -m "feat: wallet email for checkout-first registrations with finish-registration copy"
```

---

### Task 7: Return status endpoint: campaign-scoped reconcile and signed-in wallet redirect

**Files:**
- Modify: `app/api/events/[slug]/register/checkout/handler.ts`
- Modify: `app/api/events/[slug]/register/checkout/admin.ts`
- Modify: `app/api/admin/payments/_shared/ticket-access-delivery.ts` (add `mintViewerWalletGrant`)
- Test: `app/api/events/[slug]/register/checkout/handler.test.ts` (existing; add cases)
- Test: `app/api/events/[slug]/register/checkout/admin.test.ts` (existing; add cases)

**Interfaces:**
- `CheckoutStatusDeps.reconcile(record): Promise<ReconciledPayment[]>` where `ReconciledPayment = { providerPaymentId: string; buyerEmail: string }` (empty array means nothing found; the old boolean is gone).
- `CheckoutStatusDeps.markPaid(record, payments: ReconciledPayment[])` persists `matchedPayments` on the checkout doc; `PendingCheckoutRecord.matchedPayments: ReconciledPayment[]` (default `[]`).
- New optional deps: `viewerEmails?(request): Promise<string[]>` (normalized emails owned by the signed-in viewer: ID-token email plus any `user_payment_links` docs whose `uid` matches) and `viewerWalletPath?(providerPaymentId): Promise<string | null>` (mints a fresh grant for the payment's existing issuance and returns `/tickets/<grant>`).
- Response for paid: `{ status: "paid", confirmation?, viewerWalletPath?: string }`.
- Produces: `mintViewerWalletGrant(providerPaymentId: string): Promise<string | null>` in ticket-access-delivery.ts: loads `ticket_access_issuances` by `registration_<id>` or `payment_<id>` (find via the grant collection query `where("paymentIds","array-contains", paymentId)`), copies `provider, paymentIds, registrationId, eventId, eventName` into a new grant doc with a 400-day expiry, returns the raw grant.

- [ ] **Step 1: Write the failing tests**

Handler:

```ts
it("returns paid with a viewer wallet path when the signed-in viewer owns a reconciled payment", async () => {
  const record = pendingRecord({ normalizedEmail: "", registrationId: "" });
  const response = await handleCheckoutStatusRequest(
    new Request("https://x/api", { headers: { Authorization: `Bearer ${handle}` } }),
    record.returnPath,
    {
      load: async () => record,
      registrationIsPaid: async () => false,
      markPaid: vi.fn(),
      reconcile: async () => [{ providerPaymentId: "zeffy_p1", buyerEmail: "buyer@example.com" }],
      viewerEmails: async () => ["buyer@example.com"],
      viewerWalletPath: async (id) => (id === "zeffy_p1" ? "/tickets/raw-grant" : null),
    }
  );
  await expect(response.json()).resolves.toEqual({ status: "paid", viewerWalletPath: "/tickets/raw-grant" });
});
it("returns paid without a wallet path when the viewer email does not match", async () => {
  // same, viewerEmails resolves ["other@example.com"] → body { status: "paid" }
});
it("returns pending when reconcile finds nothing", async () => {
  // reconcile: async () => [] → { status: "pending", paymentUrl }
});
```

Admin (`buildCheckoutStatusDeps().reconcile`): add a case where the record has `normalizedEmail: ""` and the adapter returns two succeeded payments on the campaign with different buyer emails inside the window; assert `processProviderPayment` is invoked for both and the returned array lists both. Keep the existing email-filtered case passing for records that still carry an email (legacy in-flight checkouts).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run "src/app/api/events/[slug]/register/checkout"`
Expected: FAIL on type/shape.

- [ ] **Step 3: Implement**

handler.ts:

```ts
/** One provider payment ingested by a return-from-checkout reconcile. */
export interface ReconciledPayment {
  providerPaymentId: string;
  buyerEmail: string;
}
```

Add `matchedPayments: ReconciledPayment[]` to `PendingCheckoutRecord`; change `markPaid(record, payments)` and `reconcile` types; add `viewerEmails?` and `viewerWalletPath?`. In `handleCheckoutStatusRequest`:

```ts
  const paidResponse = async (payments: ReconciledPayment[]) => {
    const emails = deps.viewerEmails ? await deps.viewerEmails(request).catch(() => []) : [];
    const owned = payments.find((p) => emails.includes(p.buyerEmail.trim().toLowerCase()));
    const viewerWalletPath = owned && deps.viewerWalletPath
      ? await deps.viewerWalletPath(owned.providerPaymentId).catch(() => null)
      : null;
    return privateJson({
      status: "paid",
      ...(record.confirmation ? { confirmation: record.confirmation } : {}),
      ...(viewerWalletPath ? { viewerWalletPath } : {}),
    });
  };
  if (record.status === "paid" || (record.registrationId && (await deps.registrationIsPaid(record)))) {
    if (record.status !== "paid") await deps.markPaid(record, record.matchedPayments);
    return paidResponse(record.matchedPayments);
  }
  try {
    const payments = (await deps.reconcile?.(record)) ?? [];
    if (payments.length > 0) {
      await deps.markPaid(record, payments);
      return paidResponse(payments);
    }
  } catch { /* unchanged comment */ }
```

admin.ts:
- `checkoutRecord` parses `matchedPayments` (array of `{providerPaymentId, buyerEmail}` strings) defaulting to `[]`.
- `registrationPaid` returns false when `record.registrationId === ""`.
- `markPaid(record, payments)` sets `{ status: "paid", paidAtMs, matchedPayments: payments }`.
- `reconcile`: drop the email predicate when `record.normalizedEmail === ""`; collect `{ providerPaymentId: \`zeffy_${payment.id}\`, buyerEmail }` for each payment processed without throwing; return the array (the `registrationPaid` requirement is removed).
- `viewerEmails(request)`: parse the Bearer token with the same regex as `app/api/account/tickets/today/handler.ts:60`; `getAuth(adminApp()).verifyIdToken(token)`; return `[decoded.email]` normalized plus the ids of `user_payment_links` docs `where("uid","==",decoded.uid)`. Note the checkout capability also travels as a Bearer header, so the client sends the ID token in a second header `X-Viewer-Token`; read that header, not `Authorization`.
- `viewerWalletPath(id)`: `const grant = await mintViewerWalletGrant(id); return grant ? \`/tickets/${encodeURIComponent(grant)}\` : null;`

ticket-access-delivery.ts `mintViewerWalletGrant`:

```ts
/**
 * Mints a fresh wallet grant for a signed-in viewer who proved ownership of the
 * buyer email through Firebase Auth. The raw emailed grant is never stored, so
 * a sibling grant with the same scope is created instead.
 */
export async function mintViewerWalletGrant(providerPaymentId: string): Promise<string | null> {
  const db = getFirestore(adminApp());
  const paymentId = providerPaymentId.replace(/^zeffy_/, "");
  const existing = await db.collection(GRANTS)
    .where("paymentIds", "array-contains", paymentId).limit(1).get();
  const source = existing.docs[0];
  if (!source) return null;
  const issued = issueTicketAccessGrant();
  await db.collection(GRANTS).doc(issued.digest).set({
    purpose: "ticket_access",
    provider: source.get("provider"),
    paymentIds: source.get("paymentIds"),
    registrationId: source.get("registrationId") ?? null,
    eventId: source.get("eventId") ?? null,
    eventName: source.get("eventName") ?? "Event tickets",
    expiresAtMs: Date.now() + TICKET_ACCESS_TTL_MS,
    revokedAtMs: null,
    viewerMinted: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return issued.grant;
}
```

Check whether `paymentIds` stores the bare provider payment id or the `zeffy_` composite by reading `ensureTicketAccessDelivery` (`record.paymentId`) and match it. Update both file headers.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run "src/app/api/events" src/app/api/admin/payments`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/api/events/[slug]/register/checkout/handler.ts" "web/src/app/api/events/[slug]/register/checkout/handler.test.ts" "web/src/app/api/events/[slug]/register/checkout/admin.ts" "web/src/app/api/events/[slug]/register/checkout/admin.test.ts" web/src/app/api/admin/payments/_shared/ticket-access-delivery.ts
git commit -m "feat: campaign-scoped return reconcile with signed-in wallet redirect"
```

---

### Task 8: Wallet API returns unanswered required fields and participants; PATCH completes them

**Files:**
- Modify: `lib/payments/ticket-access.ts:41-64` (`TicketWalletAnswer.required`, `TicketWalletData.detailsStatus`, `participantFields`, `participants`)
- Modify: `app/api/tickets/[grant]/admin.ts:155-196` (`walletAnswers`), `:236-268` (`loadWallet`), `:300-345` (`updateAnswer` stamps `detailsStatus`), add `updateParticipants`
- Modify: `app/api/tickets/[grant]/handler.ts` (legacy PATCH branch: accept `{ participants, expectedVersion }`)
- Modify: `app/api/tickets/[grant]/route.ts` if PATCH is routed by body shape (confirm; it calls `handleTicketAnswerUpdate`)
- Test: `app/api/tickets/[grant]/admin.test.ts` and `handler.test.ts` (existing; add cases)

**Interfaces:**
- `TicketWalletAnswer` gains `required: boolean`. Unanswered required fields are emitted with value `""` (or `{ firstName: "", lastName: "" }` for `name`), `editable: true`, `required: true`.
- `TicketWalletData` gains `detailsStatus: RegistrationDetailsStatus`, `participantFields: RegistrationCustomField[]`, `participants: Array<{ name: string; fields: Record<string, RegistrationCustomFieldValue> }>`.
- `TicketGrantDeps.updateParticipants?(args: { digest; participants; expectedVersion }): Promise<TicketAnswerUpdateResult>` validates with `validateRegistrationDetails` on the participant-scoped snapshot fields, writes `participants` and `responseVersion + 1`, clears `participant:*` overrides, recomputes `detailsStatus`.
- PATCH body `{ participants: [...], expectedVersion }` (no `field`) routes to `updateParticipants`.

- [ ] **Step 1: Write the failing tests**

admin.test.ts:

```ts
it("lists unanswered required fields and detailsStatus", async () => {
  // seed grant → registration with flowSnapshot fields [shirt required], customFields {}
  const wallet = await buildTicketWalletDeps().load!(digest);
  expect(wallet?.detailsStatus).toBe("incomplete");
  expect(wallet?.answers).toContainEqual(expect.objectContaining({ field: "buyer:shirt", value: "", required: true, editable: true }));
});
it("completes details through updateAnswer and flips detailsStatus", async () => {
  const result = await buildTicketWalletDeps().updateAnswer({ digest, field: "buyer:shirt", value: "M", expectedVersion: 0 });
  expect(result.status).toBe("updated");
  const doc = await db.collection("event_registrations").doc(registrationId).get();
  expect(doc.get("detailsStatus")).toBe("complete");
});
it("replaces participants with validation", async () => {
  // snapshot fields [allergies participant required]
  const bad = await buildTicketWalletDeps().updateParticipants!({ digest, participants: [{ name: "Ana", fields: {} }], expectedVersion: 0 });
  expect(bad.status).toBe("invalid");
  const good = await buildTicketWalletDeps().updateParticipants!({ digest, participants: [{ name: "Ana", fields: { allergies: "none" } }], expectedVersion: 0 });
  expect(good.status).toBe("updated");
  expect(good.wallet.detailsStatus).toBe("complete");
});
```

handler.test.ts: PATCH with `{ participants: [...], expectedVersion: 0 }` calls `deps.updateParticipants` and returns 200 with the wallet; PATCH with neither `field` nor `participants` returns 422.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run "src/app/api/tickets"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`walletAnswers`: for each buyer field, when `value === undefined` and `field.required`, push `{ field: selector, label, value: field.type === "name" ? { firstName: "", lastName: "" } : "", editable: field.key !== "email", required: true }`; otherwise push with `required: field.required`. Same for participant fields per existing participant. `loadWallet` adds:

```ts
      detailsStatus: registrationDetailsStatus(data),
      participantFields: (flowSnapshot(data.flowSnapshot)?.fields ?? []).filter((f) => f.scope === "participant"),
      participants: (Array.isArray(data.participants) ? data.participants : []).map((p) => ({
        name: typeof p?.name === "string" ? p.name : "",
        fields: answerMap(p?.fields),
      })),
```

(defaults `"complete"`, `[]`, `[]` when no registration is linked).

`updateAnswer` transaction: after computing `overrides`, also write `detailsStatus: registrationDetailsStatus({ ...registration, responseOverrides: { ...overrides, [args.field]: args.value } })`.

`updateParticipants`:

```ts
    async updateParticipants(args) {
      const result = await db.runTransaction(async (tx) => {
        const grantSnapshot = await tx.get(db.collection(GRANTS).doc(args.digest));
        const grant = activeGrant(args.digest, grantSnapshot.data());
        if (!grant?.registrationId) return "invalid" as const;
        const registrationRef = db.collection(REGISTRATIONS).doc(grant.registrationId);
        const registrationSnapshot = await tx.get(registrationRef);
        if (!registrationSnapshot.exists) return "invalid" as const;
        const registration = registrationSnapshot.data() ?? {};
        const currentVersion = typeof registration.responseVersion === "number" ? registration.responseVersion : 0;
        if (currentVersion !== args.expectedVersion) return "conflict" as const;
        const snapshot = flowSnapshot(registration.flowSnapshot);
        if (!snapshot) return "invalid" as const;
        const participants = args.participants.map((p) => ({
          name: typeof p.name === "string" ? p.name.trim() : "",
          fields: answerMap(p.fields),
        }));
        if (participants.length > 50) return "invalid" as const;
        const errors = validateRegistrationDetails(
          { ...effectiveRegistrationInput(registration), participants },
          snapshot.fields.filter((f) => f.scope === "participant")
        );
        if (Object.keys(errors).length > 0) return "invalid" as const;
        const overrides = Object.fromEntries(
          Object.entries(answerMap(registration.responseOverrides)).filter(([k]) => !k.startsWith("participant:"))
        );
        const next = { ...registration, participants, responseOverrides: overrides };
        tx.update(registrationRef, {
          participants,
          responseOverrides: overrides,
          responseVersion: currentVersion + 1,
          detailsStatus: registrationDetailsStatus(next),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.set(db.collection(ANSWER_AUDIT).doc(), {
          registrationId: grant.registrationId, grantDigest: args.digest, field: "participants",
          priorValue: registration.participants ?? null, nextValue: participants,
          version: currentVersion + 1, createdAt: FieldValue.serverTimestamp(),
        });
        return "updated" as const;
      });
      if (result === "invalid") return { status: "invalid" };
      const wallet = await loadWallet(args.digest);
      if (!wallet) return { status: "invalid" };
      return { status: result, wallet };
    },
```

handler.ts legacy branch (`!("purpose" in wallet)`): before reading `field`, add:

```ts
    if (Array.isArray(body.participants) && deps.updateParticipants) {
      if (typeof body.expectedVersion !== "number") return privateJson({ error: "Invalid answer." }, 422);
      const result = await deps.updateParticipants({
        digest: digestTicketAccessGrant(grant),
        participants: body.participants as Array<{ name?: unknown; fields?: unknown }>,
        expectedVersion: body.expectedVersion,
      });
      if (!result || result.status === "invalid") return privateJson({ error: "Invalid participants." }, 422);
      return privateJson(result, result.status === "conflict" ? 409 : 200);
    }
```

Note the `validAnswer`/`fieldForSelector` path already permits writing a value for a field that had no prior answer, so unanswered required fields need no extra PATCH support. Update both headers.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run "src/app/api/tickets" src/lib/payments`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/payments/ticket-access.ts "web/src/app/api/tickets/[grant]/admin.ts" "web/src/app/api/tickets/[grant]/admin.test.ts" "web/src/app/api/tickets/[grant]/handler.ts" "web/src/app/api/tickets/[grant]/handler.test.ts"
git commit -m "feat: wallet exposes and completes required registration details"
```

---

### Task 9: Wallet page "Finish your registration"

**Files:**
- Modify: `app/tickets/[grant]/ticket-wallet-client.tsx`
- Test: `app/tickets/[grant]/ticket-wallet-client.test.tsx` (existing; add cases)

**Interfaces:**
- Consumes: wallet API fields from Task 8 (`detailsStatus`, `answers[].required`, `participantFields`, `participants`).

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows a finish-registration block listing blank required answers first", async () => {
  mockFetchWallet({ detailsStatus: "incomplete", answers: [
    { field: "buyer:shirt", label: "Shirt", value: "", editable: true, required: true },
    { field: "buyer:notes", label: "Notes", value: "hi", editable: true, required: false },
  ], participantFields: [], participants: [], tickets: [], answersVersion: 0, refundPending: false, eventName: "Camp" });
  render(<TicketWalletClient grant={validGrant} />);
  expect(await screen.findByRole("heading", { name: "Finish your registration" })).toBeInTheDocument();
  expect(screen.getByText("Shirt")).toBeInTheDocument();
});
it("lets the buyer add a participant when participant fields exist", async () => {
  mockFetchWallet({ detailsStatus: "incomplete", answers: [], participantFields: [
    { key: "allergies", label: "Allergies", scope: "participant", type: "text", required: true, options: [] },
  ], participants: [], /* rest */ });
  render(<TicketWalletClient grant={validGrant} />);
  await userEvent.click(await screen.findByRole("button", { name: "Add participant" }));
  await userEvent.type(screen.getByLabelText("Name"), "Ana");
  await userEvent.type(screen.getByLabelText("Allergies"), "none");
  await userEvent.click(screen.getByRole("button", { name: "Save participants" }));
  expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("/api/tickets/"), expect.objectContaining({
    method: "PATCH", body: JSON.stringify({ participants: [{ name: "Ana", fields: { allergies: "none" } }], expectedVersion: 0 }),
  }));
});
```

Adapt `mockFetchWallet`/`validGrant`/`fetchMock` to whatever helpers the existing test file uses.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run "src/app/tickets/[grant]"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Extend `WalletModel` with `detailsStatus`, `participantFields`, `participants`; `WalletAnswer` with `required`. `legacyWallet` maps them through.
- When `detailsStatus === "incomplete"`, render above the tickets:

```tsx
<section className="grid min-w-0 gap-sm rounded-md border border-warning bg-warning-muted p-md" aria-labelledby="finish-registration">
  <SectionHeading id="finish-registration" level={2}>Finish your registration</SectionHeading>
  <p className="text-body-sm text-text-secondary">Your payment is complete. Answer the required questions below to finish.</p>
</section>
```

- Sort answers so `required && answerText(value) === ""` come first, and render a "Required" label chip on them (reuse the existing answer editor).
- When `participantFields.length > 0`, render a "Participants" section: existing participants as editable rows (name input plus one `AnswerEditor` per participant field), an "Add participant" button, a "Remove" per row, and "Save participants" which PATCHes `{ participants, expectedVersion: wallet.version }` and replaces the wallet from the response (`result.wallet` via `legacyWallet`).
- Page heading: when `detailsStatus === "incomplete"` the subtitle reads "Finish your registration" instead of "My tickets". Hide the ticket pager when `tickets.length === 0`.
- Use semantic `--color-*` classes only, mobile-first layout.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run "src/app/tickets"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/tickets/[grant]/ticket-wallet-client.tsx" "web/src/app/tickets/[grant]/ticket-wallet-client.test.tsx"
git commit -m "feat: wallet finish-your-registration block and participant editor"
```

---

### Task 10: Register page: purchase screen, Buy now, waiting and paid states, signed-in redirect

**Files:**
- Modify: `app/(public)/events/[slug]/register/register-view.tsx`
- Test: `app/(public)/events/[slug]/register/register-view.test.tsx` (existing; add cases)

**Interfaces:**
- Consumes: `POST <checkoutEndpoint>` from Task 3 returning `{ paymentUrl, checkout }`; `GET <checkoutEndpoint>` returning `viewerWalletPath` from Task 7; `isCheckoutFirstFlow`, `flowRequiresDetails` from Task 1.
- `LoadState` gains `{ phase: "checkout"; event; year; flow; checkoutUrl: string; requiresDetails: boolean }`; ticket-kind Zeffy flows also use it. Manual-URL ticket flows keep `phase: "tickets"`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("renders purchase options and Buy now for a checkout-first flow, with no email field", async () => {
  mockResolvedFlow({ kind: "standard", checkout: { method: "zeffy", campaignId: "c", url: "https://z/c" },
    prices: [{ id: "p", label: "Camper", amountCents: 20000, unit: "camper", description: null }],
    fields: [{ key: "shirt", label: "Shirt", scope: "buyer", type: "text", required: true, options: [] }] });
  render(<RegisterScreen slug="camp" flowSlug="camp" />);
  expect(await screen.findByRole("button", { name: "Buy now" })).toBeInTheDocument();
  expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  expect(screen.getByText("Camper")).toBeInTheDocument();
  expect(screen.getByText(/After payment you'll be asked for:/)).toBeInTheDocument();
  expect(screen.getByText("Shirt")).toBeInTheDocument();
});
it("Buy now creates a checkout, saves it, and opens the provider URL", async () => {
  fetchMock.mockResponseOnce(JSON.stringify({ paymentUrl: "https://z/c", checkout: { handle: "h", expiresAt: 9, returnPath: "/events/camp/register/camp" } }));
  window.open = vi.fn().mockReturnValue(null);
  // ...render, click Buy now
  expect(fetchMock).toHaveBeenCalledWith("/api/events/camp/register/camp/checkout", expect.objectContaining({ method: "POST" }));
  expect(window.location.assign ?? window.open).toHaveBeenCalled();
  expect(await screen.findByText(/If you completed your payment, watch your email for next steps/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Buy again" })).toBeInTheDocument();
});
it("shows finish-registration copy when paid and the flow has required questions", async () => {
  // saved cart present; GET returns { status: "paid" }
  expect(await screen.findByText(/check the email you used at checkout for a link to finish your registration/i)).toBeInTheDocument();
});
it("shows view-your-tickets copy when paid and the flow has no required questions", ...);
it("redirects a signed-in owner to the wallet", async () => {
  // useAuth mocked with a user; GET returns { status: "paid", viewerWalletPath: "/tickets/g" }
  expect(routerReplace).toHaveBeenCalledWith("/tickets/g");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run "src/app/(public)/events/[slug]/register"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- In the load effect: after resolving `flow`, if `isCheckoutFirstFlow(flow)` set `{ phase: "checkout", event, year, flow, checkoutUrl: flow.checkout.url || flow.checkout.manualFallbackUrl, requiresDetails: flowRequiresDetails(flow) }` (closed when no URL). Keep the manual-URL `tickets` branch.
- Extract the popup-or-navigate logic from `payNow` into `openCheckout(url: string)` and reuse it.
- `buyNow`:

```ts
  const buyNow = async (): Promise<void> => {
    if (state.phase !== "checkout") return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch(checkoutEndpoint, { method: "POST" });
      const data = (await res.json()) as { paymentUrl?: string; checkout?: PendingCheckoutCart; error?: string };
      if (!res.ok || !data.paymentUrl || !data.checkout) {
        setSubmitError(data.error ?? "Checkout could not be started.");
        return;
      }
      savePendingCheckout(data.checkout);
      setSavedCheckout({ phase: "pending", cart: data.checkout, paymentUrl: data.paymentUrl });
      openCheckout(data.paymentUrl);
    } catch {
      setSubmitError("Checkout could not be started.");
    } finally {
      setSubmitting(false);
    }
  };
```

- Purchase screen (phase `checkout`, no saved checkout): banner, heading, `pricingDescription`, the existing "Available at checkout" price list (lift into a small `PricePreview` component inside the file), a paragraph "After payment you'll be asked for:" followed by a list of required field labels when `requiresDetails`, the Buy now `Button` (disabled while submitting), the recovery link when `showRecovery`, and `submitError` alert.
- Saved-checkout screen when `state.phase === "checkout"`: heading "Payment received" when paid, else "Waiting for your payment". Pending/checking copy: "If you completed your payment, watch your email for next steps. If you didn't, you can go back and purchase." with buttons "Buy again" (calls `openCheckout(savedCheckout.paymentUrl)`) and "Check payment status". Paid copy: `requiresDetails ? "Check the email you used at checkout for a link to finish your registration." : "Check the email you used at checkout for a link to view your tickets."`. Do not render the "Use this email at Zeffy" block or the alternate-email section in this phase (there is no linking email); keep the payment-inquiry link (`/events/${slug}/payment-inquiry`) as a plain link under the copy.
- Poll with the viewer token: in `checkSavedCheckout`, when `user` exists, add header `"X-Viewer-Token": await user.getIdToken()`. When the response carries `viewerWalletPath`, call `router.replace(viewerWalletPath)` (import `useRouter` from `next/navigation`). Add `user` to the callback deps.
- Remove the `zeffyForm`/`showRegistrationForm` Zeffy branches that are now unreachable for Zeffy flows (keep `collectRegistrationInfo` handling for non-Zeffy external-URL flows untouched). Update the file header.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run "src/app/(public)/events"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/(public)/events/[slug]/register/register-view.tsx" "web/src/app/(public)/events/[slug]/register/register-view.test.tsx"
git commit -m "feat: checkout-first purchase screen with Buy now and status-aware return"
```

---

### Task 11: Admin flow editor gating

**Files:**
- Modify: `app/admin/hosted-events/[slug]/settings/settings-view.tsx:2059-2073`
- Test: `app/admin/hosted-events/[slug]/settings/settings-view.test.tsx` (existing; add a case)

- [ ] **Step 1: Write the failing test**

```tsx
it("hides collect-before-checkout for a Zeffy flow and explains details are collected after payment", async () => {
  // render with a standard flow whose checkout.method === "zeffy"
  expect(screen.queryByLabelText("Collect registration information before checkout")).not.toBeInTheDocument();
  expect(screen.getByText("Details are collected after payment in the buyer's wallet.")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run "src/app/admin/hosted-events/[slug]/settings/settings-view.test.tsx" -t "hides collect"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the `{flow.kind !== "tickets" ? (...) : null}` block:

```tsx
{flow.kind !== "tickets" && !isCheckoutFirstFlow(flow) ? (
  /* existing checkbox label unchanged */
) : flow.kind !== "tickets" ? (
  <span className="text-body-sm text-text-secondary">
    Details are collected after payment in the buyer&apos;s wallet.
  </span>
) : null}
```

Import `isCheckoutFirstFlow`. The editor's `flow` state carries `checkout`; confirm the property name at `settings-view.tsx:364` region and use it.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run "src/app/admin/hosted-events/[slug]/settings"`
Expected: PASS (these tests are load-sensitive; rerun the file alone if a timeout appears).

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/admin/hosted-events/[slug]/settings/settings-view.tsx" "web/src/app/admin/hosted-events/[slug]/settings/settings-view.test.tsx"
git commit -m "feat: hide pre-checkout collection for checkout-first flows"
```

---

### Task 12: Admin "Details pending" rows and detail view

**Files:**
- Modify: `components/admin/events/registrations-roster.ts:40-46` (`RegistrationRow.detailsStatus`), plus the row builder in the same file where `paymentStatus` is read from the document
- Modify: `components/admin/events/registrations-table.tsx:70-85, 273-285`
- Modify: `components/admin/events/registration-details.tsx:45-55`
- Test: `components/admin/events/registrations-table.test.tsx` and `registration-details.test.tsx` (existing; add cases)

- [ ] **Step 1: Write the failing tests**

```tsx
it("labels a paid registration with incomplete details as Details pending", () => {
  render(<RegistrationsTable rows={[{ ...paidRow, detailsStatus: "incomplete" }]} /* other required props */ />);
  expect(screen.getByText("Details pending")).toBeInTheDocument();
});
```

Details:

```tsx
it("lists blank required fields for a details-pending registration", () => {
  render(<RegistrationDetails registration={{ ...paidRegistration, detailsStatus: "incomplete", flowSnapshot: snapshotWith([shirtRequired]), customFields: {} }} /* props */ />);
  expect(screen.getByText("Details pending")).toBeInTheDocument();
  expect(screen.getByText("Still needed: Shirt")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/admin/events`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `RegistrationRow.detailsStatus?: "complete" | "incomplete"`; read `data.detailsStatus` next to `paymentStatus` in the roster row builder (and in the export handler's row projection if it constructs rows separately).
- Table: the status cell renders `Details pending` with `bg-warning-muted text-warning` when `row.detailsStatus === "incomplete" && status === "paid"`, otherwise the existing pill. Do not change the `InvoiceStatus` union.
- Details view: same pill rule; when incomplete, compute `validateRegistrationDetails(effectiveRegistrationInput(registration), registration.flowSnapshot.fields)` and render one line `Still needed: <labels joined by ", ">` mapping error keys back to field labels (`customFields.<key>`/`<key>` to the buyer field label; `participants.<i>.fields.<key>` to `<participant name> — <label>`; `participants` to "At least one participant").
- Exports: confirm `app/api/admin/hosted-events/[slug]/registrations/export/handler.ts` includes rows with `paymentStatus === "paid"` regardless of `detailsStatus` (no change expected; add an assertion to its test if cheap).

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/components/admin/events "src/app/api/admin/hosted-events/[slug]/registrations"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/admin/events/registrations-roster.ts web/src/components/admin/events/registrations-table.tsx web/src/components/admin/events/registrations-table.test.tsx web/src/components/admin/events/registration-details.tsx web/src/components/admin/events/registration-details.test.tsx
git commit -m "feat: show Details pending for paid registrations missing required answers"
```

---

### Task 13: Docs, gates, and integration

**Files:**
- Modify: `docs/Development/hosted-event-registration-flow-operations.md` (checkout-first section replacing the pre-checkout form description; note no Zeffy cancel callback)
- Modify: `docs/Designs/hosted-event-registration-flows.md` (flow diagram: purchase → ingest → wallet)

- [ ] **Step 1: Update docs** with the behavior contract summary (items 1 to 16 of the spec) and the operator note that alpha ingests on return polling while prod also ingests via webhook, both idempotent.
- [ ] **Step 2: Run the gates from the worktree**

```bash
./scripts/dev-build.sh check 2>&1 | tail -20
./scripts/dev-build.sh build 2>&1 | tail -20
npm --prefix functions run build
```

Expected: GREEN markers for check and build; functions build exits 0. Use `set -o pipefail` or read the GREEN/RED marker, not tail's exit code.

- [ ] **Step 3: Commit docs**

```bash
git add docs/Development/hosted-event-registration-flow-operations.md docs/Designs/hosted-event-registration-flows.md
git commit -m "docs: checkout-first registration flow"
```

- [ ] **Step 4: Integrate** with `.orchestrator/scripts/worktree-merge.sh <sha...>` under the `.worktree-merge` lock, then cherry-pick onto local `main` so the dev server picks it up, then `orch docs sync --json` (never `git add -A` afterwards).
- [ ] **Step 5: Manual walk on alpha**: open a Zeffy flow, Buy now, complete a test purchase, return, confirm the wallet email arrives with "Finish my registration", complete the fields, confirm the admin row flips from Details pending to Paid.
