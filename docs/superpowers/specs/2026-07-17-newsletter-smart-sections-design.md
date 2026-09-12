# Newsletter Smart (Dynamic) Sections — Design

Date: 2026-07-17

## Summary

Add "smart sections" to the Band Happenings section model: sections whose body is
**dynamic content resolved at render time** (upcoming volunteer opportunities,
upcoming events, next concert, a picked big-event poster), each keeping its own
**editable intro MDX** + heading. Resolved live for the public web page and at
email-send time; previewed live via a new API. Empty smart sections are omitted.

## Decisions (confirmed)

- v1 kinds: `volunteer_opportunities`, `upcoming_events`, `next_concert`, `event_poster`.
- Preview resolves live via a preview API.
- Empty (no items) → the section is hidden from web + email + preview.
- Extra details = one section-level intro MDX block (no per-item notes in v1).
- Card styling reuses the home-page widgets (`UpcomingEvents`, `UpcomingConcerts`,
  `UpcomingVolunteerNeeds`).

## Model (`web/src/lib/content/sections/types.ts`)

Extend `SectionBlock` (keep `type: "section"` — do NOT change the discriminator or
`isSectionBody`):
```ts
kind?: SmartSectionKind;              // "volunteer_opportunities" | "upcoming_events" | "next_concert" | "event_poster"
config?: {
  limit?: number;                     // max items for the list kinds
  posterRef?: { source: "hosted_event" | "concert"; id: string };  // event_poster
};
```
`heading` + `mdx` stay (mdx = the editable intro). Update `parseSection`,
`serializeSectionBody`, and the round-trip test. `validateMdxComponents` needs no
change (the intro `mdx` is validated by the existing per-section loop).

## Registry framework (new `web/src/lib/content/smart-sections/`)

A per-kind module registry so kinds are self-contained and easy to add:
```ts
interface SmartSectionKindModule<Item> {
  kind: SmartSectionKind;
  label: string;                      // "Upcoming events"
  description: string;                // shown in the Add-section chooser
  resolve(config, deps): Promise<Item[]>;   // [] => hidden
  WebCards: React.FC<{ items: Item[] }>;    // client-safe web render (below the intro)
  emailCards(items: Item[], opts: { baseUrl: string }): string;  // mail-safe HTML
  configFields?: ...;                 // optional editor config UI hints
}
```
`deps` supplies the existing public helpers (client Firebase SDK, which runs in all
three server contexts): `listUpcomingHostedEvents`, `listUpcomingConcerts`, a new
thin `listUpcomingVolunteerOpportunities` wrapper (list published + filter
`(endsAt ?? startsAt) >= now`, sort by `startsAt`), `getHostedEvent`/`getConcert`.

`resolveSmartSections(sections, deps)`: for each `section.kind`, call the module's
`resolve`; attach `resolved` (transient) to the section; DROP sections that resolve
empty. Returns `ResolvedSectionBlock[]`.

## Rendering

- Web: `SectionBand` (`PostBody.tsx`) — when `section.kind`, render heading + intro
  `MdxBody(section.mdx)` + `<module.WebCards items={section.resolved.items} />`.
- Email: `renderSectionBandRows` (`sections/render-email.ts`) — heading + intro via
  `renderMdxToEmailHtml` + `module.emailCards(items, {baseUrl})` (tables/inline styles).
- Empty sections never reach the renderers (dropped in resolve).

## Resolve wiring (3 call sites, all Next server contexts / client SDK)

1. Public web page `app/(public)/news/[slug]/page.tsx` `resolvePostBody` — also run
   `resolveSmartSections` before `<PostBody>`.
2. Email send `app/api/comms/band-happenings/send/admin.ts` `resolveSections` — also
   resolve smart sections (live at send, then frozen into the outbox HTML).
3. NEW preview API `POST /api/comms/band-happenings/preview-smart` — body
   `{ sections }`; returns `{ resolved: Record<sectionId, ResolvedPayload> }`
   (gate: `bandHappeningsAccess().canView`, Bearer auth like the other BH routes).

## Preview wiring

`BandHappeningsWorkbench` fetches `preview-smart` when the preview opens (idToken),
merges `resolved` into the `sections` passed to `<BandHappeningsPreview>`, so the
Website + Email preview tabs render real upcoming content. The inline
selected-section preview card shows heading + intro + a "live content" placeholder
(no resolved data there).

## Editor

- `AddSectionDialog`: new "Smart section" choice → a kind picker (label+description
  from the registry) → inserts a smart `SectionBlock` (default heading + empty mdx +
  kind + default config).
- `SectionEditDialog`: when `draft.kind`, show a "Smart content" panel — a note of
  what it shows, config controls (max items for lists; a dropdown of hosted
  events + concerts for `event_poster`), plus the existing heading + intro
  `SectionMarkdownEditor` (labelled "Extra details (optional)").
- Poster dropdown candidates: workbench fetches `listHostedEvents`/`listConcerts`
  client-side and passes them to the editor.
- Section cards (`SectionTableOfContents`) show a "Smart: <label>" badge.

## The four kinds

- **volunteer_opportunities**: cards (title, date, location, `heroImageUrl`) + "View
  slots" → `/volunteer/opportunities/[id]`; show spots-left if cheaply available.
- **upcoming_events**: hosted-event cards (poster/cover, `dates`) + "Details" →
  `/events/[slug]`.
- **next_concert**: next concert (poster + name + date/time/location) + "See the
  program" → `/concerts/[slug]/program`. (Reference kind, built with the framework.)
- **event_poster**: author-picked hosted event OR concert (config.posterRef) →
  large poster (`posterUrl`) + name + CTA to its page.

## Build plan (dependency-layered, parallel worktree agents + worktree-merge.sh)

- S1 (foundation): model + registry framework + resolver + web/email render branches
  + empty-hide + all 3 resolve wirings + preview API + workbench preview wiring +
  AddSectionDialog + SectionEditDialog smart panel + **next_concert** as the reference
  kind. TDD; land.
- S2/S3/S4 (parallel, after S1): `volunteer_opportunities`, `upcoming_events`,
  `event_poster` — each a self-contained registry module (+ one registry line +
  editor config hint). TDD; land.

Each stream green in its worktree (`./scripts/dev-build.sh check`) before integrating
via `.orchestrator/scripts/worktree-merge.sh`.

## Deploy / ops notes

- Verify Firestore composite indexes for the reused queries already exist (the home
  page uses them, so likely yes); a NEW published+date query for volunteer upcoming
  may need an index (see [[new-content-collection-needs-index]]).
- No new Slack/notification config.
