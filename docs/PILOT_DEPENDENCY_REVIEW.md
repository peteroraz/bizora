# Pilot dependency and supply-chain review

Pilot readiness, item 27. Reviewed on 23 Nov 2026 against `main` (lockfile `pnpm-lock.yaml`).

## Summary

| Check | Result |
| --- | --- |
| `pnpm audit --prod` (CI gate) | **Passes.** 1 high advisory (zod), ignored with an ADR (below). No critical issues. |
| `pnpm audit` (including development tools) | 4 moderate advisories, all in test and lint tools that never run in a deployed service. |
| Production packages | 367 (name and version), across the API, web, admin and shared packages. |
| Licences of production packages | 238 MIT, 26 Apache-2.0, 16 BSD-3-Clause, 11 ISC, and others. No GPL or AGPL. Notes below. |
| Lockfile | Committed; CI installs with `--frozen-lockfile`, so a build cannot pick up an unreviewed version. |
| Secrets in the repository | Gitleaks runs on every push and pull request (`ci.yml`). |
| Container base image | `node:22-alpine` for the API, web and admin images. Multi-stage builds, so the production image has no build tools. |
| GitHub Actions | Official or vendor actions only (`actions/*`, `docker/*`, `google-github-actions/*`, `hashicorp/*`, `pnpm/*`, `gitleaks/*`), pinned to major versions. |
| Cloud credentials in CI | None stored. Workload Identity Federation, limited to `main` (staging) and the `production` environment, which has required reviewers. |
| Offline voice models | Fetched at build time and checked file by file against SHA-256 in `apps/web/src/lib/voice/models.lock.json`. A changed file fails the build. |

## Advisories

### Ignored, with an ADR (production dependencies)

| Advisory | Package | Why it is accepted | ADR |
| --- | --- | --- | --- |
| GHSA-mrhx-c7xc-m3w5 (ReDoS in email checks) | zod 3.25 | Only on rate-limited sign-in, sign-up and invitation routes, with length-capped input. Zod 4 is a breaking migration. | ADR-004 |
| GHSA-fc5q-39xc-vjpf (ReDoS in extglobs) | picomatch, via next-intl's build plugin | Used only to watch source files while building. No user input reaches it at runtime. No fixed version yet. | ADR-023 |

`pnpm audit --prod` reports "1 high (1 ignored)": that is the zod advisory. With the ignore list emptied, it is the only one reported. The picomatch advisory is no longer reported, so its ignore in `package.json` can be removed: ADR-023's removal trigger. That is left for a separate change, so this review changes no dependency.

### Development tools only (not in any deployed image)

| Advisory | Package | Severity | Path | Plan |
| --- | --- | --- | --- | --- |
| GHSA-82fw-gwwq-j7x9 | vitest, @vitest/mocker below 4.1.11 | moderate | test runner | Upgrade vitest to 4.1.12 or later after the pilot starts. It runs only on developers' machines and CI, against this repository's own tests. |
| GHSA-qxg6-89mg-rqv8 | @vitest/mocker below 4.1.12 | moderate | test runner | Same upgrade. |
| GHSA-g3hv-75wg-m249 | minimatch 7 to 11.0.0 | moderate | `typescript-eslint` (lint) | Comes with the next typescript-eslint update; lint runs only on this repository's files. |

None of these is reachable by a trader, an owner or anyone on the internet.

## Licences

| Package | Licence | Why it is acceptable |
| --- | --- | --- |
| `@img/sharp-libvips-linux-x64`, `@img/sharp-libvips-linuxmusl-x64` | LGPL-3.0-or-later | libvips, loaded dynamically by `sharp` (images in Next.js), unmodified. LGPL allows this; keep it as a separate, replaceable library and do not change its source. |
| `dejavu-fonts-ttf` | Reported as "Unknown" | The DejaVu fonts' own licence is a permissive Bitstream Vera derivative. Used for PDF receipts. |
| One CC-BY-4.0 package (data), one SIL Open Font Licence font, one Unlicense, one 0BSD | Permissive | Attribution is kept in the packages. |

None needs legal sign-off for the pilot. Before general availability, have counsel confirm the licence list (`pnpm licenses list --prod`).

## How to repeat this review

```bash
pnpm audit --prod                 # the CI gate
pnpm audit                        # including development tools
pnpm licenses list --prod --json  # licences
pnpm outdated -r                  # what is behind
```

Repeat before every production release and at least once a month during the pilot. Any new ignore needs an ADR (ADR-004 rule).

## Not done

- **No software bill of materials (SBOM) is published.** `pnpm licenses list` and the lockfile serve as the inventory for the pilot.
- **Container images are not scanned in CI.** Artifact Registry's vulnerability scanning can be switched on in the Google Cloud console; it is not set by Terraform today.
- **Actions are pinned to major versions, not to commit SHAs.** A compromised action release could run in CI. CI has no stored cloud keys, and production needs a reviewer.
