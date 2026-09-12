<!--
DoubTech CI — deliverable naming and versioning guide.

Explains how a build declares what each artifact IS — the `<artifact>.json`
sidecar carrying a deliverable name and version, read by the node-agent at
publish time and stored on the artifact row — and what the dashboard falls back
to when a build declares nothing. Written for build authors editing a
repository's `.doubtech-ci.yml`, and for anyone reading the project page's
download cards and wondering where their names and version numbers come from.

Copyright (c) 2026 Doubling Technologies. Use of this file is governed by the
LICENSE file in the repository root.
-->

# DoubTech CI — Naming and Versioning Your Deliverables

A **deliverable** is one named thing your project ships for one platform: an
installer, a portable archive, a container image tarball. The project page shows
a download card per deliverable — its name, its current version, the commit that
produced it, and the versions before it.

CI cannot infer any of that from the bytes it receives. Declare it, and the
cards read the way you want them to; declare nothing, and the dashboard falls
back to guessing from the filename.

## Declare a name and version

Alongside each artifact your package phase produces, write a sidecar file with
the same path plus `.json`:

```
dist/
  MyApp-linux.tar.gz
  MyApp-linux.tar.gz.json
```

```json
{ "name": "MyApp", "version": "1.2.3.45" }
```

Both fields are optional — declare a version alone, a name alone, or both — but
**unknown keys are rejected**, so a typo like `verison` is reported in the build
log rather than silently costing you a version. A sidecar that cannot be parsed
never fails the build; the artifact publishes without labels and the log says
why.

`version` is free text. Semver, `1.2.3.45`, a calendar version, a build number —
whatever your release process already produces. It is displayed, not compared.

Nothing else changes in your pipeline. Collect the sidecars with your artifacts
and CI does the rest:

```yaml
package:
  - run: ./build.sh && ./write-metadata.sh
    artifacts: ["dist/*"]
```

A glob like `dist/*` matches the sidecars too. That is fine and expected: the
agent recognizes a `.json` file that sits beside a matched artifact and uses it
as metadata instead of publishing it as a deliverable of its own. A JSON file
your project genuinely ships — one with no matching artifact beside it — is
still published normally.

### Writing the sidecar

Any step that can write a file will do. From a Node project:

```yaml
package:
  - run: npm pack
  - run: node -e "const p=require('./package.json');require('fs').writeFileSync(`${p.name}-${p.version}.tgz.json`,JSON.stringify({name:p.name,version:p.version}))"
    artifacts: ["*.tgz", "*.tgz.json"]
```

From a shell build:

```yaml
package:
  - run: |
      ./build.sh
      printf '{"name":"MyApp","version":"%s"}' "$(cat VERSION)" > dist/MyApp-linux.tar.gz.json
    artifacts: ["dist/*"]
```

## What happens without a sidecar

Every artifact uploaded before this contract existed — and every build that
never adopts it — still gets a card. The dashboard guesses:

| Card field | Declared | Not declared |
|---|---|---|
| Name | the sidecar's `name` | the filename with version, date, and commit-sha segments stripped: `MyApp-1.2.3-linux.tar.gz` → `MyApp-linux` |
| Version | the sidecar's `version` | a dotted version found in the filename (`MyApp-1.2.3-linux.tar.gz` → `1.2.3`), else the build's short commit sha |

The guess is good enough to be useful and not good enough to rely on. Two
artifacts whose filenames reduce to the same name — say a `.deb` and a
`.tar.gz` — stay separate cards, because the extension is part of the fallback
identity. But a filename that carries no stable part, or that changes shape
between releases, will scatter one deliverable across several cards. Declaring a
name fixes that permanently: **cards group by declared name first**, so two
builds that agree on `name` are always the same card no matter what their files
are called.

## Where the data goes

1. The build writes `dist/MyApp-linux.tar.gz` and `dist/MyApp-linux.tar.gz.json`.
2. The node-agent expands the package step's `artifacts` globs, drops the
   sidecars from the publish list, and reads each one
   (`shared/src/artifactMetadata.ts`).
3. It publishes the artifact with the declared labels — as `?name=&version=`
   query parameters on `PUT /api/jobs/:jobId/artifacts`, or in the request body
   of the shared-filesystem handoff `POST /api/jobs/:jobId/artifacts/local`.
4. The server stores them on the `artifacts` row (`name`, `version`, both
   nullable) and returns them with the artifact everywhere it is listed.
5. The project page folds the recent builds' artifacts into one card per
   deliverable (`web/src/deliverable.ts`) and renders the download cards
   (`web/src/components/DeliverableCards.tsx`).

The version list on a card covers the recent builds the project page already
loads, not the project's entire history. Artifacts the retention sweep has
pruned keep their rows but not their bytes.
