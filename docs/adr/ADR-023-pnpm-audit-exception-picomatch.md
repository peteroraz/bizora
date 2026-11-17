# ADR-023: pnpm audit exception GHSA-fc5q-39xc-vjpf (picomatch)

## Status

Accepted on 17 Nov 2026, until a patched picomatch is published or the conditions below change. Follows the rule in ADR-004: no audit ignore without an ADR.

## Context

On 17 Nov 2026 `pnpm audit --prod` began reporting [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf):
- **Issue:** a ReDoS in picomatch through single-branch repeated extglobs.
- **Affected versions:** up to 4.0.7, the version in the lockfile.
- **Fix:** none published (the advisory lists no patched version).
- **Path:** `apps/web > next-intl > @parcel/watcher > picomatch`.

`@parcel/watcher` is used only by next-intl's Next.js plugin and its message extractor (`SourceFileWatcher`), to watch the app's own source and message files during development and builds. The glob patterns come from the plugin's configuration in this repository. No request, upload or other user input reaches picomatch at runtime: the API does not depend on it, and the web server does not use the watcher.

## Decision

Add `GHSA-fc5q-39xc-vjpf` to `pnpm.auditConfig.ignoreGhsas`, so `pnpm audit --prod` stays a blocking CI gate for every other advisory.

## Removal trigger

Remove the ignore, and let CI fail, as soon as any of these is true:

- picomatch publishes a fixed release. Then update the lockfile and remove the ignore in the same PR.
- next-intl drops `@parcel/watcher`, or Bizora stops using next-intl's plugin or extractor.
- Any runtime code path starts passing user-supplied text to picomatch or to `@parcel/watcher`.
