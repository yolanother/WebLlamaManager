# Committees

The Governance section's committee module: the board's record of its standing
and special committees, who chairs them, who serves on them, what authority
membership carries, and the markdown each committee produces while it works.

Gated behind the `committees` platform feature flag (Admin → Settings →
Features). Every route 404s while the flag is off.

## What a committee is

A `committees/{committeeId}` document holds:

| Field | Meaning |
|---|---|
| `name` | Display name, e.g. "Scholarship Committee" |
| `summary` | Short plain-text blurb, shown on the committee card |
| `purpose` | **Markdown** — the full description of its charge |
| `limitations` | **Markdown** — the bounds of its authority |
| `imageUrl` / `imageAlt` | Optional feature art, shown on the card and detail page |
| `chairUids` | Designated chair(s); a chair manages the roster |
| `memberUids` | Every member, chairs included |
| `grantedRoleIds` | Platform roles granted **by membership** |
| `seasonId` | Season slug the committee is stamped to |
| `endDate` | ISO dissolution date, or null for a standing committee |
| `motionBy` / `motionAt` | Provenance of the motion that created it |

Chairs are always folded into `memberUids`, so demoting a chair leaves them on
the committee as a plain member rather than orphaning them. Alt text is
normalized together with the image: clearing the art clears the alt, so alt text
is never orphaned and an image is never left undescribed.

The `summary` is deliberately separate from the markdown `purpose`. A card needs
one predictable line; the first paragraph of a markdown document is not that.

Feature art is chosen with the shared `ImageChooser` (library, upload, or
Unsplash) and stored under `committee-images/{committeeId}/`, the same Storage
namespace that holds images embedded in the committee's markdown documents.

## Membership grants platform roles

This is the part worth understanding before changing anything here.

Roles listed in `grantedRoleIds` are granted to every member. Rather than
introduce a second permission source, membership is **materialized as ordinary
`role_assignments` documents**, so claims-sync, the Firestore rules helpers, and
the server-side permission evaluator all keep working untouched.

Committee-owned assignments carry a `source` field of `committee:<committeeId>`.
Reconciliation only ever touches assignments bearing that tag, so a role someone
was granted by hand keeps its own untagged assignment and survives being removed
from the committee.

`diffCommitteeGrants(before, after)` in `web/src/lib/governance/committees.ts` is
the pure function that computes what to grant and revoke on any write — member
added or removed, role attached or detached, committee created or dissolved.

### Elected board seats are never attachable

`president`, `vp_fundraising`, `treasurer`, `secretary`, and `voting_member`
cannot be granted through a committee. The four officer seats carry admin
authority and `voting_member` confers board membership; neither is a committee's
to hand out, and a chair who can add members would otherwise be able to mint an
officer.

The filter (`isAttachableRoleId`) is applied in four places on purpose: on the
form's role list, on input at the API, on read from storage, and again inside the
grant diff. A board seat that somehow reached storage still grants nothing.

### The escalation the design accepts

Within that ceiling, a chair adding a member **does** grant that member the
committee's roles immediately. That is the delegation designating a chair exists
to provide — the board picks the roles, the chair picks the people. Every
committee-driven grant and revocation is written to the audit log under the
`governance` domain.

## Why the API is the sole writer

Firestore rules deny **every client write** to `committees`, and deny client
reads *and* writes to the documents subcollection.

The reason is not caution, it is a hard constraint: `role_assignments` rules gate
writes on `isAdminOfficer()`, and a committee chair is deliberately not an
officer. A client-side committee write could therefore never perform its own
grant reconciliation without widening the role-assignment rule to non-officers.
Instead `/api/committees` authenticates the caller's ID token, checks
board-versus-chair authority itself, and performs the committee write and the
role reconciliation together with the Admin SDK.

| Route | Who |
|---|---|
| `GET /api/committees` | Any signed-in member |
| `POST /api/committees` | Board only |
| `GET /api/committees/{id}` | Any signed-in member |
| `PATCH /api/committees/{id}` | Board (any field); chair (`memberUids` **only**) |
| `DELETE /api/committees/{id}` | Board only; revokes every grant |

A chair reaching for a field they may not write gets a **403**, not a silently
ignored key.

## The detail page is read-only by default

`/admin/committees/{id}` renders as a RECORD, not a form. Feature art, the
markdown charge and limitations, the granted roles, the motion provenance, and
the roster are all plain content. Every mutation sits behind an icon button that
opens a modal:

| Control | Where | Who sees it | Opens |
|---|---|---|---|
| Message | `PageTitleBar` header | board, chair | the message composer |
| Edit | `PageTitleBar` header | board | the full committee form |
| Dissolve | `PageTitleBar` header | board | the confirm dialog |
| Add person | Membership card heading | board, chair | the member editor |

PAGE-level actions go in the header's `iconActions`, never a hand-rolled button
row above the body — that is the convention across every admin page. The
add-person control is CARD-level and stays inline with the Membership heading it
belongs to. The index page follows the same rule: "New committee" is a header
action, board-gated.

Both `CommitteesManager` and `CommitteeDetail` therefore own their own
`PageTitleBar` rather than letting the route shell render it — the header needs
the board-permission flag and the committee's name, and only the client
component that loads them knows either.

### Never show an identifier

Two rules the committee UI holds to, both of which were bugs once:

- **A user id is never rendered.** `PeopleField` shows a skeleton chip until the
  account directory resolves, rather than the uid, so ids do not flash on screen
  before names arrive. An account that has since been deleted reads "Former
  member". Role ids get the same treatment through `useAttachableRoles().labelFor`,
  so a custom role shows its label rather than `hospitality_lead`.
- **The breadcrumb is named from the record.** The route segment is an opaque
  document id, so `CommitteeDetail` owns the page header and passes the
  committee's name to `PortalBreadcrumbs` via its `leafLabel` prop. Until the
  record loads the generic "Committee" label from `adminLeafLabel` is shown —
  the id never is. `leafLabel` is available to any detail page with the same
  problem.

## Committee documents

`committees/{committeeId}/documents/{documentId}` holds the markdown a committee
produces: charter, meeting notes, drafts, recommendations. Documents live under
their committee because they have no life outside it, so dissolving the
committee deletes them with it.

- **Published** documents are visible to any signed-in member.
- **Drafts** are visible only to the committee's own members and the board.

That split depends on committee membership, which a Firestore rule cannot
evaluate without reading the parent document — which is why the subcollection
denies client reads as well as writes and the API serves both directions. A draft
requested directly by someone who may not see it answers **404, not 403**, so the
existence of an unpublished recommendation is not itself disclosed.

Authoring is the board plus the committee's own chair(s). Editing reuses the
shared `MarkdownEditor` with an image upload handler wired to the
`committee-images/{committeeId}/` Storage namespace — inline `data:` and
`blob:` image sources are stripped by the markdown sanitizer and would vanish on
save.

> **Known limitation:** Storage rules cannot read a committee's chair list, so
> the image namespace is writable by `canManageContent()` (board/admin). A chair
> who is not a board member can write documents but cannot upload images into
> them.

## Messaging a committee

Two paths, deliberately:

1. **Mailroom committee audience target** — `{ kind: "committee", committeeId }`.
   Goes through the normal compose/approve/schedule/send pipeline. Gated on the
   `comms` admin scope. Use for board-level mail. A dissolved committee resolves
   to zero recipients rather than throwing, so one stale target cannot block an
   otherwise-valid send.

2. **"Message committee" composer** on the committee page —
   `POST /api/committees/{id}/message`. Subject and body, fanned out through the
   notification pipeline (in-app, email, push). Authorized on committee authority
   (board or this committee's chair), so a chair without the `comms` scope can
   still reach their own committee. No scheduling, approval, or attachments — that
   is what Mailroom is for.

Messages file under the existing `governance` notification category, so a
member's existing preference and the administrator's existing Slack channel
mapping both apply with no new setup.

## Deploy checklist

Committee work touches rules and functions, neither of which
`./scripts/dev-build.sh check` covers:

```bash
firebase deploy --only firestore:rules
firebase deploy --only storage:rules
npm --prefix functions run build && firebase deploy --only functions
```

The functions deploy is required for the Mailroom committee target to resolve;
without it a committee target silently reaches nobody.

## Key files

| Concern | File |
|---|---|
| Domain types, predicates, grant diff | `web/src/lib/governance/committees.ts` |
| Document types, visibility, invariants | `web/src/lib/governance/committee-documents.ts` |
| Committee request core | `web/src/app/api/committees/handler.ts` |
| Documents request core | `web/src/app/api/committees/documents-handler.ts` |
| Message request core | `web/src/app/api/committees/message-handler.ts` |
| Admin SDK wiring | `web/src/app/api/committees/admin.ts`, `message-admin.ts` |
| Admin UI | `web/src/components/admin/committees/` |
| Role labelling (never raw ids) | `web/src/components/admin/committees/use-attachable-roles.ts` |
| Mailroom target resolution | `functions/src/mailroom/resolve.ts` |
| Feature registry entry | `web/src/lib/platform/features/registry.ts` |
