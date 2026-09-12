# Hosted event share menu

`web/src/components/events/event-share-menu.tsx` renders a share icon in two
places: inline with the event title on each `/admin/hosted-events` card, and in
the public `/events/{slug}` title header beside the permission-gated admin cog
(the share control itself is public — any visitor can copy or scan). It opens a
small menu (closed by an outside pointer-down or Escape):

- **Copy link** — writes the absolute public URL (`window.location.origin` +
  `/events/{slug}`) to the clipboard and swaps the icon for a check for two
  seconds. Resolving from the current origin means alpha shares alpha links and
  prod shares prod links without any server lookup.
- **Show QR code** — opens the shared `Modal` with a QR image encoding that same
  URL, the URL as text, and a light/dark `Switch`. Light is brand navy
  (`#213355`, `--color-brand`) on white; dark is white modules on navy, for
  posters and dark social graphics.

The QR is encoded client-side with the already-installed `qrcode` package
(`QRCode.toDataURL`), the same library the concert program footer uses on the
server. The hex values are literal because the encoder cannot read CSS tokens;
update them if `--color-brand` changes.

Tests: `web/src/components/events/event-share-menu.test.tsx`.
