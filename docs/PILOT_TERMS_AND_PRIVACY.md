# Pilot terms and privacy

Pilot readiness, item 25. 23 Nov 2026; the pilot section went live on 24 Nov 2026.

## What changed in the app

- **Terms of use** (`/terms`), **version 2026-11-24** (ADR-068). Section **13. The pilot** is now live. It says:
  - Bizora is a test version in a pilot: it may have faults, change or be unavailable, and holds no security or data protection certification;
  - Bizora support may see the records read-only, as section 5 explains, and every look is shown to the owner;
  - Google Cloud keeps the records for Bizora; backups are kept but are not a promise; the owner should download their own copy;
  - experimental features, such as saying a sale, may be wrong more often, and must be checked before confirming; features can be switched per business;
  - **offline storage on the phone:** products, prices, stock, customer names and unsent work stay on the device until sent. Lock phones, and do not clear the browser's data while work is waiting;
  - **voice on the phone:** speech is turned into words on the phone, and the recording is not sent or kept. It can mishear names, numbers and amounts, is tested in English only, and nothing is saved until checked and confirmed;
  - Bizora is **not accounting, tax or legal advice**;
  - the pilot may end, with at least 30 days' notice and time to download records.

  Every owner is asked to accept the new version the next time they open the app. `admin-part2.test.ts` checks it.
- **Privacy notice** (`/privacy`). Two paragraphs are added:
  - **offline storage:** what the phone keeps, and that it is removed when Shop mode is signed out with nothing waiting;
  - **on-phone voice:** speech is turned into words on the phone, the recording never leaves it, and only a confirmed sale is sent.

  Already there: the pilot measures, and the owner's records download. A privacy notice can be updated without asking people to accept it again.
- **Both are still marked "Draft — to be reviewed by counsel".** Counsel's review is needed before general availability. If they change the terms, `TERMS_VERSION` moves again and owners accept once more.

## What must not be said

These are in `docs/PILOT_READINESS_REPORT.md` as rules for every page, email and conversation:

- "Production-ready", "generally available" or "launched". It is a pilot.
- Any certification, such as ISO 27001, SOC 2 or NDPC registration as a data processor, until it is held.
- That voice understands Pidgin, Hausa, Yoruba or Igbo. It is measured on English, with a few Pidgin-influenced sentences.
- That backups have been restored, until the restore drill has been run and logged (`docs/runbooks/restore.md`).
