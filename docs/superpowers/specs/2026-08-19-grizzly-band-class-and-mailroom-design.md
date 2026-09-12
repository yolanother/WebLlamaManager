# Grizzly Band season class, section sync, and Mailroom consolidation

**Date:** 2026-08-19
**Status:** Approved for implementation

## Problem

Three related gaps, discovered by reading production Firestore
(`band-boosters-572c5`) rather than the code alone:

1. **No student is placed in a class.** The `memberships` collection holds 87
   documents for season `2026-2027`, every one of them keyed
   `<studentId>_<seasonId>` with `ensembleId: ""`. These are dues stubs written
   by the payment ingestion path (`web/src/app/api/admin/payments/ingestion/deps.ts`,
   `web/src/app/api/admin/payments/review/deps.ts`), whose own comment says "a
   later unit may enrich it". Nothing has enriched them. Consequently every
   surface that reads ensemble placement — attendance grouping by
   `ensemble:`/`ensembleInstrument:`, the section directory, concert rosters,
   and Mailroom's `ensemble` audience target — resolves to nothing for Grizzly
   Band.

2. **The Grizzly Band section list does not describe the band.**
   `ensembles/grizzly-band.sections` is `["Woodwinds", "Brass", "Low Brass",
   "Percussion"]`. The 2026 band camp attendance data describes eleven real
   instrument sections.

3. **Three competing composers.** Mail can be sent from
   `/admin/comms/mailroom` (Compose tab), `/admin/comms/mailing-list` (its own
   officer MDX composer), and `/admin/comms/compose` (a separate targeted
   announcement form). The last reads its ensemble options from
   `org_settings.ensembles`, which is `[]` in production, so it is already
   inert — but it is the only surface that can target an ensemble **section**.

Separately, no send path shows the operator who will actually receive a
message. The Mailroom recipient preview returns a total, per-target counts, and
a capped sample of raw addresses — never named people.

## Production data this design is derived from

Band camp 2026 ran as five `band_camp` calendar days generated from hosted
event `band-camp`, year `2026` (Aug 10–14, 2026):

| Event id | Day | Records |
| --- | --- | --- |
| `zewBw98EK6c3XokhOMEV` | 1 | 84 |
| `0Glw5C3MfVxy3hxtRnkm` | 2 | 83 |
| `4v9vYGVaboar6HnOrdTu` | 3 | 83 |
| `xEVqlITsiFjSQhKK0CoH` | 4 | 80 |
| `bARDy8db7BjGUUx7az4V` | 5 | 78 |

87 distinct participant ids appear across those days: 86 roster students, plus
one unlinked Zeffy registration participant
(`registration:zeffy_f98c76bc-…:0`, "Desi de la Torre", no `students` document).

Every one of the 86 roster students carries a `marchingInstrument`. Its eleven
distinct values, with counts:

| Instrument | Students |
| --- | --- |
| Drumline (Percussion) | 18 |
| Trumpet | 17 |
| Flute / Piccolo | 10 |
| Clarinet | 9 |
| Trombone | 9 |
| Tenor Saxophone | 6 |
| Alto Saxophone | 5 |
| Mellophone (French Horn) | 4 |
| Sousaphone (Tuba) | 4 |
| Baritone | 2 |
| Drum Major | 2 |

### Decisions on edge cases

- **Victoria Voytukhov** (`gb24_stu_920832`) appears on the camp sheet but is
  marked `absent` on her single record and `attendingBandCamp: false`. **Excluded.**
- **Desi de la Torre** exists only as a Zeffy registration participant. **Excluded**
  (no roster student, no instrument to place them in a section).
- **Colin Cassady** and **Matthew Kang** are flagged `attendingBandCamp` on the
  roster but have no camp attendance record. **Excluded.**

The eligible set is therefore **the 85 students with at least one `present`
record across the five camp days**.

## Design

### 1 — Grizzly Band season class

`ensembles/grizzly-band.sections` is replaced with the eleven marching
instruments in score order:

```
Flute / Piccolo, Clarinet, Alto Saxophone, Tenor Saxophone, Trumpet,
Mellophone (French Horn), Trombone, Baritone, Sousaphone (Tuba),
Drumline (Percussion), Drum Major
```

Section and instrument are 1:1 for this ensemble: a membership's `section` is
the student's `marchingInstrument` and its `instruments` array is
`[marchingInstrument]`.

A new idempotent script, `scripts/migrate-content/seed-grizzly-band-memberships.ts`,
performs the placement. It is `--dry-run` by default and requires `--apply` to
write. It:

- resolves the band camp attendance days from hosted event `band-camp` / year
  `2026` rather than hard-coding the five calendar event ids;
- collects student ids with at least one `present` record;
- writes `memberships/<studentId>_grizzly-band_2026-2027`;
- never touches the `ensembleId: ""` dues stubs.

**Document key.** The composite `<studentId>_<ensembleId>_<seasonId>` key is
deliberate. It is deterministic (so the script is re-runnable), it never
collides with the dues stub key, and it leaves room for the same student to
hold Jazz Band and Wind Ensemble memberships in the same season — which the
existing `<studentId>_<seasonId>` scheme cannot express.

### 2 — One mailroom

- Mailroom gains a `Subscribers` tab mounting `MailingListManager` with its
  duplicate MDX composer removed. The subscriber directory, bulk-add,
  unsubscribe, and campaign history panels remain.
- `/admin/comms/mailing-list` redirects to `/admin/comms/mailroom?tab=subscribers`.
- `/admin/comms/compose` redirects to `/admin/comms/mailroom?tab=compose`.
- `AdminNav` drops the "Mailing" group and the "Compose message" entry.
- Because retiring `/admin/comms/compose` would otherwise lose a capability,
  Mailroom's `ensemble` audience target gains an optional **section** selector,
  populated from the target ensemble's `sections`.

### 3 — Preview, confirm, and scoped authority

**Named recipient resolution.** The Mailroom preview result grows from
`{ total, byTarget, sample }` to also carry a resolved roster: for each
recipient, the person's name, the student they are attached to (with grade and
section), the delivery address, and whether they are the student or a copied
guardian. The list is capped with an explicit "and N more" tail so a
mailing-list-sized audience does not blow the document size.

**Confirmation step.** `Send` and `Schedule` no longer dispatch directly. Both
route through a confirmation view showing the rendered email body, the audience
summary, and the recipient table. This applies to every Mailroom send, not only
the attendance-scoped ones.

**Recipient mode.** `defaultRecipientMode` becomes `students`. An explicit
"Also send to parents" toggle flips it to `both`.

**Scoped send authority.** A new server-side predicate decides whether a caller
may dispatch a given set of audience targets:

- Admin officers and holders of `comms.send` may send to anything.
- A caller who may take attendance for an event classification (per the
  existing `canTakeAttendance` predicate and the `attendanceEventAdminTags`
  metadata) may send **only** to targets covered by that classification — the
  matching ensemble and its sections, and that event's registrants. A Grizzly
  Band Coordinator can mail Grizzly Band and nothing else.

The predicate is enforced in the message send/schedule action and mirrored in
the audience picker so the UI never offers a target the server will reject.
This is the only new security surface in the design and carries both unit tests
and Firestore emulator rules tests.

**Contextual entry.** An "Email this group" control on the attendance sheet and
on the class roster deep-links into Mailroom compose pre-targeted at that
ensemble or event.

### 4 — The Grizzly Band message

The message to the 85 band camp students is authored as a Mailroom draft
targeted at the Grizzly Band ensemble, students-only, and dispatched through
the new confirmation step. Copy is supplied by the operator.

## Testing

- **Piece 1**: unit tests over the eligible-set derivation and the membership
  document shape, against fixtures drawn from the real day/record structure.
  Production application is gated on a reviewed dry-run diff.
- **Piece 2**: route redirect tests; nav model test; a section-selector test on
  the audience picker.
- **Piece 3**: unit tests for the scoped-authority predicate (officer,
  scope-holder, coordinator-in-scope, coordinator-out-of-scope, unauthorized);
  emulator rules tests mirroring them; a handler test proving an out-of-scope
  target is rejected server-side even when the client submits it; component
  tests for the confirmation step and the parents toggle.

## Out of scope

- Reconciling the two meanings of the `memberships` collection (dues stub
  versus class placement). Both continue to coexist; the composite key keeps
  them from colliding.
- Backfilling class placements for ensembles other than Grizzly Band.
- Migrating the legacy `org_settings.ensembles` config, which is empty and now
  has no reader once `/admin/comms/compose` retires.
