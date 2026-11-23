# Pilot terms and privacy

Pilot readiness, item 25. 23 Nov 2026.

## What changed in the app

- **Privacy notice** (`/privacy`). It now says:
  - While Bizora is in its pilot, it **counts how it is used**: sales made offline, changes refused when a phone syncs, voice downloads that failed. The counts never include what was said or typed, amounts, names or phone numbers (ADR-045).
  - The owner can **download all of the business's records** at any time from Settings.

  A privacy notice can be updated without asking people to accept it again.
- **Terms of use** (`/terms`, version 2026-11-20). **Not changed.**
  - They already say that Bizora is free for now, provided as it is, may change, and keeps backups without promising none will fail.
  - They already cover support access, photo reading and limits of responsibility.
  - Changing them means a new version that every owner must accept (section 11), and they are still marked "Draft — to be reviewed by counsel". So the pilot wording below is a **proposal for counsel**, not live text.

## Proposed pilot section for the Terms of use (for counsel)

> **13. The pilot**
>
> Bizora is being tried with a small number of businesses before it is offered to everyone (the pilot). During the pilot:
>
> - Some features are marked **experimental**, such as saying a sale on the phone. They may be wrong more often than other features. Check everything they fill in before you confirm it.
> - We may switch a feature on or off for your business, for example to find a fault. You can see every change and its reason in Settings, Bizora support.
> - We count how Bizora is used, as the Privacy notice explains, to find problems. The counts never include what was said or typed, amounts, names or phone numbers.
> - Bizora does not take card or online payments. Record payments you received in cash, by transfer or by POS.
> - Keep your own copy of your records: download them from Settings, as often as you like.
> - Bizora does not hold any security or data protection certification yet, and does not claim one.
> - The pilot may end. If it does, we will tell you at least 30 days ahead, and you can download your records before your account is closed.

If counsel accepts it, bump `TERMS_VERSION` in `packages/contracts/src/identity.ts` and the version in the text. Owners will be asked to accept the new version the next time they open the app. The tests that check the version need updating in the same change.

## What must not be said

These are in `docs/PILOT_READINESS_REPORT.md` as rules for every page, email and conversation:

- "Production-ready", "generally available" or "launched". It is a pilot.
- Any certification, such as ISO 27001, SOC 2 or NDPC registration as a data processor, until it is held.
- That voice understands Pidgin, Hausa, Yoruba or Igbo. It is measured on English, with a few Pidgin-influenced sentences.
- That backups have been restored, until the restore drill has been run and logged (`docs/runbooks/restore.md`).
