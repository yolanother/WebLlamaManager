# Band Happenings Review & Inline Commenting — Design

Date: 2026-07-17
Orch task: 3Aixuar8G8yxyDhu1HRGS

## Summary

Add a **Review** tab to the Band Happenings preview modal that web-renders the
current draft with per-section change badges (diffed against the last **saved**
draft) and lets editors/reviewers leave **threaded inline comments** per section,
plus an **overall comments** block for requesting sections that aren't present.
A comment **summary** lists all threads; clicking a section-anchored comment
**jumps to and highlights** that section in the editor. Leaving a comment/reply
fires a **configurable notification** (new dedicated category → an admin-mapped
Slack channel + the web notification bell) to everyone with Band Happenings edit
access.

## Decisions (confirmed with the operator)

- **Diff baseline:** compare vs the last **saved** draft (not last sent issue).
  Section `id`s are stable within a draft, so change matching is exact:
  `Added` / `Edited` / `Unchanged`, and removed sections render as tombstones.
- **Comment structure:** **threaded** replies; **editors resolve** (any BH
  contributor OR the secretary can resolve).
- **Notifications:** a **new dedicated** `band_happenings_review` category
  (independently configurable), **debounced** (~5 min) so bursts collapse into
  one notification. Delivered to the web bell for BH editors + a configured
  Slack channel.
- **Jump-to:** clicking a section comment **closes the preview and
  scrolls/highlights** that section in the editor (new controlled selection prop).
- Editors targeted by **role** (president / vp_fundraising / treasurer /
  secretary / director). Custom per-section action-claim editors are not
  role-targetable and won't receive the notification.
- Comments are visible to anyone who can view the workbench.

## Architecture

### Data model (Firestore, Admin-SDK-only, mirrors governance minutes-corrections)

`band_happenings_comments/{id}`:
`postId`, `sectionId: string | null` (null = overall / "request a section"),
`body`, `authorUid`, `authorName`, `createdAt`, `resolved`,
`resolvedByUid|Name`, `resolvedAt`, `replyCount`.

`band_happenings_comment_replies/{id}`:
`commentId`, `postId`, `body`, `authorUid`, `authorName`, `createdAt`.

Rules: `allow read, write: if false` — all access via API + Admin SDK, consistent
with existing BH writes and the notification center. Comments/replies frozen once
`posts.reviewStatus === "sent"`.

### API (`/api/comms/band-happenings/comments`, nodejs runtime, Bearer + verifyIdToken)

- `GET ?postId=` → `{ comments, replies }` — gate `canView`.
- `POST` create `{ postId, sectionId|null, body }` — gate contributor OR
  secretary; `reviewStatus !== "sent"`; enqueue debounced notification (non-fatal).
- `POST /[commentId]/replies` `{ postId, body }` — same gate; notification.
- `POST /[commentId]/resolve` `{ postId, resolved }` — same gate; limited update.

All mirror the existing BH route auth/IDOR pattern (`category === "band-happenings"`
guard). Client helpers added to `web/src/lib/comms/band-happenings-client.ts`:
`listBandHappeningsComments`, `addBandHappeningsComment`,
`replyToBandHappeningsComment`, `resolveBandHappeningsComment`.

### Notifications

- Add `"band_happenings_review"` to `NOTIFICATION_CATEGORIES`
  (`web/src/lib/notifications/types.ts`) + a label in the preferences UI.
- Producer `buildBandHappeningsCommentBatchInput({ postId, slug, actorUid,
  sectionHint })` → `NotificationBatchInput` (batchKey `bh-comment:{postId}`,
  category `band_happenings_review`, recipients
  `{kind:"roles", roleIds:[president,vp_fundraising,treasurer,secretary,director]}`,
  delivery `{ slackChannelKeys:["band_happenings_review"] }`, links to the review
  view + workbench). Enqueued via `enqueueNotificationBatch` from the create/reply
  routes, wrapped non-fatally.

### Review tab (`BandHappeningsPreview`)

New third tab `review`. New props: `baselineSections` (last saved), `comments`,
`replies`, `canComment`, comment handlers, `onJumpToSection`. Renders each current
section (web render via `PostBody`/`SectionBand`) with a change badge, a
comment-count pill, an inline composer + threaded replies + resolve. Removed
sections render as tombstones. Overall comments block at the bottom. Summary strip
at top ("N open · M resolved", expandable, click-to-jump).

### Jump-to-section (`SectionPostEditor`)

New controlled props `focusSectionId?: string | null` + `onSectionFocused?()`.
When `focusSectionId` changes to a present section, the editor selects it, scrolls
its card into view, applies a brief highlight, then calls `onSectionFocused` so the
parent clears the request. Workbench wires `onJumpToSection` → set `focusSectionId`
+ `closePreview`.

### Workbench wiring

Load comments client-side (idToken) on mount + after mutations; pass
`baselineSections` (from the persisted snapshot, held in state for reactivity),
comments/replies + handlers to the preview; deep-link `?preview=1&review=1` opens
the review tab directly (used by the notification link).

## Build plan (parallel worktree agents + worktree-merge.sh)

- Wave 1 (parallel): **A** notifications (category + producer + prefs UI),
  **C** `SectionPostEditor` focus prop.
- Wave 2: **B** comments lib + API + client helpers + rules (needs A).
- Wave 3: **D** review tab + comment UI + workbench wiring (needs B + C).

Each stream is TDD, green in its own worktree (`./scripts/dev-build.sh check` +
targeted tests) before integration; integrated one at a time via
`.orchestrator/scripts/worktree-merge.sh <sha>` under the `.worktree-merge` lock.
Final full prod build on main.

## Deploy needs (after merge)

- Deploy Firestore rules.
- New notification category ships with the code.
- Map the `band_happenings_review` Slack channel key in Slack admin settings.
