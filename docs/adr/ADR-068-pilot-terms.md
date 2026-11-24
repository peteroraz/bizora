# ADR-068: A pilot section in the Terms of use, and privacy on the phone

## Status

Accepted on 24 Nov 2026. Builds on ADR-039 (Terms of use, accepting a new version). The terms and privacy notice are still marked "Draft — to be reviewed by counsel".

## Context

`docs/PILOT_TERMS_AND_PRIVACY.md` proposed a pilot section and left it for counsel, because changing the terms makes every owner accept again. The owner asked for it to go in before the pilot. It must say plainly:
- what the pilot is;
- how support sees records;
- how data and backups are handled;
- which features are experimental;
- what is kept on the phone;
- that voice is processed on the phone and has limits;
- that Bizora is not accounting or tax advice.

## Decision

- **Terms of use, section 13 "The pilot"**, version **2026-11-24** (`TERMS_VERSION`). It covers:
  - the test nature of the pilot, and no certification;
  - support access (pointing to section 5);
  - Google Cloud keeping the records, and that backups are not a promise;
  - the owner's own download;
  - experimental features and switches;
  - what the phone keeps offline, and that unsent work cannot be recovered by Bizora;
  - on-phone speech, never sent or kept, English only, misheard numbers;
  - not accounting, tax or legal advice;
  - 30 days' notice if the pilot ends.
- **Privacy notice**, two paragraphs (no new version needed):
  - what the phone keeps for offline work, and when it is removed;
  - that speech is turned into words on the phone and the recording never leaves it.
- **Owners accept again** the next time they open the app (ADR-039's acceptance screen). New sign-ups accept 2026-11-24.

## Consequences

- Every pilot owner sees the acceptance screen once after this is deployed.
- Counsel still has to review the whole text. If they change it, the version moves again.
- `admin-part2.test.ts` checks the new version.
