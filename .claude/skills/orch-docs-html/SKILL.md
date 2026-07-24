---
name: orch-docs-html
description: "Author self-contained HTML under /docs that renders correctly in the orchestrator docs viewer — slide decks, interactive walkthroughs, and clickable UI mockups. Use when the user says: 'create a slide deck', 'make a slideshow / presentation in docs', 'html mockup in /docs', 'interactive walkthrough', 'walkthrough deck', 'build a deck under docs', or wants a hand-authored HTML page (not a designer-canvas image mockup) that lives in a project's /docs and shows in the docs tab. NOT for designer-canvas image mockups (use orch-create-mockup) or one-off hero images (use orch-generate-image)."
visibility: public
allowed-tools: Bash, Read, Write, Edit, Glob
argument-hint: "<what to build, e.g. 'interview walkthrough slide deck' or 'settings page mockup'> [under docs/<Dir>]"
---

# Author HTML slide decks & mockups under /docs

Produce a **self-contained** HTML page under a project's `/docs` (a slide deck,
walkthrough, or clickable mockup) that renders correctly and safely in the
orchestrator **docs viewer**. The viewer has a specific contract — get it wrong
and images 404, scripts silently die, or nothing shows. This skill encodes the
working recipe so a deck takes minutes, not a debugging session.

Reference implementation to crib from: the `nf-take-home-android` project's
`docs/Slides/` (`interview-walkthrough.html` + `index.md` + `assets/`).

---

## THE DOCS-VIEWER CONTRACT (read this first — every rule cost someone a fix)

The viewer renders `.html` docs inside a **sandboxed `srcDoc` iframe** and
inlines your assets before display. That imposes hard constraints:

1. **Assets must be synced as docs — keep them in the deck's own `assets/`
   dir.** The viewer resolves and inlines relative references (`<img
   src="assets/hero.png">`, `srcset`, CSS `url(...)`, sibling `<link>`/`<script
   src>`) by matching them against the project's **other synced documents**.
   A file resolves ONLY if it lives under `/docs` (that's what `orch docs sync`
   uploads). So:
   - ✅ `<img src="assets/hero.png">` where `docs/<Dir>/assets/hero.png` exists → resolves.
   - ✅ `../shared/logo.svg` if `docs/shared/logo.svg` exists → resolves.
   - ❌ `../../Screenshots/foo.png` pointing OUTSIDE `/docs` → never synced → 404.
   **Default behavior: copy every screenshot/image the deck needs INTO the
   deck's own `assets/` dir** (duplicating a repo screenshot into
   `docs/<Dir>/assets/` is fine and expected). Use plain relative `src`s — do
   NOT hand-inline data-URIs; the viewer does that.

2. **No external network dependencies.** No CDN fonts, scripts, or stylesheets;
   no `fetch()` to remote hosts; no Google Fonts `<link>`. The deck must render
   fully offline. Use system font stacks and bundle any JS/CSS inline or as
   sibling docs under the deck dir.

3. **The iframe is an OPAQUE-ORIGIN sandbox (`allow-scripts`, NOT
   `allow-same-origin`).** Your scripts DO run — but the frame has no access to
   `localStorage`/`sessionStorage`, cookies, the parent app, or same-origin
   fetch (they throw `SecurityError`). So:
   - Keep slide/nav state **in memory + `location.hash`** (hash works inside the
     frame — e.g. `#5` for slide 5). Do NOT persist to `localStorage`.
   - Wrap any storage access in `try/catch` so a throw doesn't kill the deck.

4. **The viewer already provides a full-screen button** (top-right of the
   frame). Don't build your own fullscreen UI; just make the layout fill the
   viewport (`100vw`/`100vh`, `object-fit`, etc.) so it looks right when
   maximized.

5. **Respect `prefers-reduced-motion`** — gate entrance/transition animations
   behind `@media (prefers-reduced-motion: no-preference)`.

---

## Recipe

### 1. Track the work (per the project CLAUDE.md orch preamble)
Create/te an orch task, mark it `in_progress`, and report progress as you go —
deck authoring is real work and must be tracked (create → in_progress →
progress notes → completed).

### 2. Scaffold under /docs
```
docs/<Dir>/                      e.g. docs/Slides/
  <name>.html                    the deck/mockup (self-contained)
  index.md                       REQUIRED — every docs dir needs an index.md
  assets/                        all images/fonts/media the html references
```
Start the HTML from the **Templates** appendix at the bottom of this skill (also
mirrored as `templates/deck.html` / `templates/mockup.html` in the skill dir when
present) — both are self-contained, offline, and obey the contract (keyboard
←/→, click, and `#n` hash nav; print CSS; reduced-motion; opaque-origin-safe
state). Copy the whole file and edit the content, don't rebuild the shell.

### 3. Bring in images
For hand-supplied images: copy them into `assets/` and reference `assets/<file>`.

For **generated** hero/section art, use this EXACT sequence (the documented
`--wait` on `orch image generate` does not exist; work around it):
```bash
orch branding list --json                     # pick a --branding slug (e.g. netflix)
orch image generate "<prompt>" --branding <slug> --json   # capture data.job.id
#   quality: OMIT --quality, or use low|medium|high|auto ONLY.
#   'hd' is REJECTED by gpt-image-2 and hard-fails the job (wastes an attempt).
orch image status <jobId> --wait --json       # wait here; capture data.attachmentId
# Download the finished image straight into the deck's assets/ (authenticated):
orch attachments download <attachmentId> -o docs/<Dir>/assets/hero.png
```
Then reference `assets/hero.png` from the HTML. (`orch attachments download`
requires CLI ≥ 0.2.231; older CLIs must curl
`<serverUrl>/api/v1/attachments/<attachmentId>/file` with a bearer token.)

### 4. Docs conventions + sync
- Write `docs/<Dir>/index.md` (title + one-line description + link to the deck).
- Link the deck from `docs/README.md` (and optionally the root README).
- Run `orch docs sync` so the KB + docs viewer pick it up (and the assets get
  uploaded so the viewer can inline them).

### 5. Verify the render (don't skip)
Headless-screenshot representative slides — a text review will not catch SVG
label overflow, clipped layouts, or off-canvas content:
```bash
chrome --headless --screenshot=/tmp/slide1.png --window-size=1440,900 "file://$PWD/docs/<Dir>/<name>.html"
chrome --headless --screenshot=/tmp/slide5.png --window-size=1440,900 "file://$PWD/docs/<Dir>/<name>.html#5"
```
Check a few slides + a dense one. **Note:** CSS entrance animations get captured
mid-frame in headless — a half-faded element is the animation, not a bug.
Report which slides you screenshotted and what you checked.

### 6. Report + complete
Progress-note what shipped (deck path, slide count, generated assets), then set
the orch task `completed`.

---

## Acceptance checklist
- [ ] Deck/mockup lives under `docs/<Dir>/`, is self-contained (no CDN/network).
- [ ] Every referenced image is under `docs/<Dir>/assets/` (or elsewhere under
      `/docs`) and resolves in the docs viewer — no repo-relative paths escaping
      `/docs`, no hand-inlined data-URIs.
- [ ] Nav works (keyboard + click + `#n` hash); state avoids `localStorage`.
- [ ] Image-gen (if used) succeeded first try: async job → `status --wait` →
      attachment download; `--quality` omitted or validated per model.
- [ ] `index.md` present, linked from `docs/README.md`, `orch docs sync` run.
- [ ] Headless render verified; findings reported.
- [ ] Orch task created → in_progress → progress → completed.

---

## Templates (copy verbatim, then edit the content)

### deck.html — self-contained slide deck

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deck</title>
<!--
  Self-contained slide deck for the orchestrator docs viewer.
  CONTRACT (see the orch-docs-html skill):
    - No external network deps (no CDN fonts/scripts). Everything is inline.
    - Images live in ./assets/ and are referenced relatively (the viewer inlines them).
    - Runs in an opaque-origin sandbox: scripts work, but NO localStorage/cookies.
      Nav state is in-memory + location.hash only.
    - The viewer supplies its own full-screen button; this just fills the frame.
  Nav: ArrowRight/Space/click = next, ArrowLeft = prev, Home/End, and #<n> deep-links.
-->
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b0b0f; color: #f4f4f5; overflow: hidden;
  }
  .deck { position: relative; width: 100vw; height: 100vh; }
  .slide {
    position: absolute; inset: 0; display: none;
    flex-direction: column; justify-content: center; align-items: center;
    padding: 6vmin; text-align: center; gap: 3vmin;
  }
  .slide.active { display: flex; }
  @media (prefers-reduced-motion: no-preference) {
    .slide.active > * { animation: rise .5s cubic-bezier(.2,.7,.2,1) both; }
    .slide.active > *:nth-child(2) { animation-delay: .08s; }
    .slide.active > *:nth-child(3) { animation-delay: .16s; }
    @keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
  }
  h1 { font-size: clamp(28px, 6vmin, 64px); line-height: 1.05; letter-spacing: -.02em; }
  h2 { font-size: clamp(22px, 4.5vmin, 44px); line-height: 1.1; letter-spacing: -.01em; }
  p, li { font-size: clamp(15px, 2.4vmin, 24px); line-height: 1.5; color: #c9c9d2; max-width: 60ch; }
  ul { text-align: left; display: grid; gap: 1.2vmin; }
  img.hero { max-width: min(80vw, 900px); max-height: 50vh; object-fit: contain; border-radius: 14px; }
  .accent { color: #7c9cff; }
  .progress { position: fixed; left: 0; bottom: 0; height: 3px; background: #7c9cff; transition: width .3s ease; z-index: 5; }
  .counter { position: fixed; right: 14px; bottom: 12px; font-size: 13px; color: #6b6b76; z-index: 5; }
  .hint { position: fixed; left: 14px; bottom: 12px; font-size: 12px; color: #4b4b55; z-index: 5; }

  /* Print / PDF export: show every slide stacked. */
  @media print {
    body { overflow: visible; background: #fff; color: #111; }
    .slide { position: static; display: flex !important; height: 100vh; page-break-after: always; }
    .progress, .counter, .hint { display: none; }
  }
</style>
</head>
<body>
  <main class="deck" id="deck">
    <section class="slide">
      <h1>Deck title <span class="accent">goes here</span></h1>
      <p>One-line subtitle or context for the walkthrough.</p>
    </section>

    <section class="slide">
      <h2>A point with a picture</h2>
      <img class="hero" src="assets/hero.png" alt="Describe the image">
      <p>Keep captions short. Images resolve from <code>assets/</code>.</p>
    </section>

    <section class="slide">
      <h2>A bulleted slide</h2>
      <ul>
        <li>First idea, tight and scannable.</li>
        <li>Second idea.</li>
        <li>Third idea.</li>
      </ul>
    </section>

    <section class="slide">
      <h1>Thanks</h1>
      <p>Questions?</p>
    </section>
  </main>

  <div class="progress" id="progress"></div>
  <div class="counter" id="counter"></div>
  <div class="hint">← → to navigate · click to advance</div>

  <script>
    (function () {
      var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
      var i = 0;

      function clamp(n) { return Math.max(0, Math.min(slides.length - 1, n)); }
      function fromHash() {
        var n = parseInt((location.hash || '').replace('#', ''), 10);
        return isNaN(n) ? 0 : clamp(n - 1); // #1 == first slide
      }
      function render() {
        slides.forEach(function (s, idx) { s.classList.toggle('active', idx === i); });
        document.getElementById('progress').style.width = ((i + 1) / slides.length * 100) + '%';
        document.getElementById('counter').textContent = (i + 1) + ' / ' + slides.length;
      }
      function go(n, updateHash) {
        i = clamp(n);
        if (updateHash !== false) {
          // location.hash is safe in the opaque-origin sandbox (localStorage is NOT).
          try { history.replaceState(null, '', '#' + (i + 1)); } catch (e) { location.hash = '#' + (i + 1); }
        }
        render();
      }

      document.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(i + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(i - 1); }
        else if (e.key === 'Home') { go(0); }
        else if (e.key === 'End') { go(slides.length - 1); }
      });
      document.getElementById('deck').addEventListener('click', function () { go(i + 1); });
      window.addEventListener('hashchange', function () { go(fromHash(), false); });

      i = fromHash();
      render();
    })();
  </script>
</body>
</html>
```

### mockup.html — self-contained clickable mockup

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mockup</title>
<!--
  Self-contained clickable UI mockup for the orchestrator docs viewer.
  Same CONTRACT as the deck (see the orch-docs-html skill):
    - No external network deps. Images in ./assets/, referenced relatively.
    - Opaque-origin sandbox: scripts run, NO localStorage/cookies. Screen state
      is in-memory + location.hash (#screen-id).
    - The viewer supplies full-screen; this just fills the frame.
  Multiple "screens"; hotspots (data-goto="<screen-id>") navigate between them.
-->
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #14141a; color: #e9e9ef;
    display: grid; place-items: center; min-height: 100vh; padding: 4vmin; overflow: auto;
  }
  .stage { width: min(1200px, 96vw); }
  .screen { display: none; }
  .screen.active { display: block; }
  @media (prefers-reduced-motion: no-preference) {
    .screen.active { animation: fade .25s ease both; }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  }
  /* A neutral app-frame chrome so mockups read as a product screen. */
  .frame { border: 1px solid #2a2a35; border-radius: 16px; overflow: hidden; background: #1b1b22; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  .titlebar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #22222c; border-bottom: 1px solid #2a2a35; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #3a3a46; }
  .titlebar .name { margin-left: 8px; font-size: 13px; color: #9a9aa6; }
  .body { padding: clamp(16px, 3vw, 36px); min-height: 60vh; }
  h1 { font-size: clamp(22px, 3vw, 34px); margin-bottom: 12px; letter-spacing: -.01em; }
  p { color: #b6b6c2; line-height: 1.5; max-width: 60ch; }
  img { max-width: 100%; border-radius: 10px; display: block; }
  /* Clickable hotspots. */
  [data-goto] { cursor: pointer; }
  .btn { display: inline-block; margin-top: 18px; padding: 10px 18px; border-radius: 10px; background: #6d7cff; color: #fff; font-weight: 600; }
  .hint { position: fixed; left: 14px; bottom: 12px; font-size: 12px; color: #55555f; }
</style>
</head>
<body>
  <div class="stage">
    <!-- Screen 1 -->
    <section class="screen frame" id="home">
      <div class="titlebar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="name">App · Home</span></div>
      <div class="body">
        <h1>Home screen</h1>
        <p>Describe the screen. Put annotated screenshots in <code>assets/</code> and reference them relatively.</p>
        <!-- <img src="assets/home.png" alt="Home screenshot"> -->
        <span class="btn" data-goto="detail">Go to detail →</span>
      </div>
    </section>

    <!-- Screen 2 -->
    <section class="screen frame" id="detail">
      <div class="titlebar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="name">App · Detail</span></div>
      <div class="body">
        <h1>Detail screen</h1>
        <p>A second screen. Any element with <code>data-goto="&lt;id&gt;"</code> is a hotspot.</p>
        <span class="btn" data-goto="home">← Back home</span>
      </div>
    </section>
  </div>
  <div class="hint">click hotspots to navigate · deep-link with #screen-id</div>

  <script>
    (function () {
      var screens = Array.prototype.slice.call(document.querySelectorAll('.screen'));
      function show(id) {
        var found = false;
        screens.forEach(function (s) { var on = s.id === id; s.classList.toggle('active', on); found = found || on; });
        if (!found && screens[0]) screens[0].classList.add('active');
      }
      function current() { return (location.hash || '').replace('#', '') || (screens[0] && screens[0].id); }
      document.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-goto]') : null;
        if (!t) return;
        var id = t.getAttribute('data-goto');
        // hash nav is safe in the sandbox; localStorage is NOT.
        try { history.replaceState(null, '', '#' + id); } catch (err) { location.hash = '#' + id; }
        show(id);
      });
      window.addEventListener('hashchange', function () { show(current()); });
      show(current());
    })();
  </script>
</body>
</html>
```
