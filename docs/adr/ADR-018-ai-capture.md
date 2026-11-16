# ADR-018: AI capture of photos, scans and voice notes

## Status

Accepted. Implements Spec Addendum v1.2 roadmap Sprint 5d (§16). Builds on ADR-015 (imports and the review table).

## Context

Many traders keep records in exercise books, on supplier invoices and delivery notes, or in their heads. Typing them in is the biggest barrier to adoption. Large multimodal models can now read handwriting and understand Nigerian Pidgin, Yoruba, Igbo and Hausa speech well enough to produce a first draft. But they make mistakes, and anything written in a photo could try to steer them.

## Decision

### Flow

1. On the product import, sales import or the new **Record a delivery** screen, a person:
   - takes or chooses photos (up to 6, shrunk on the phone to 2,000 pixels as JPEG);
   - chooses a PDF; or
   - records a voice note (up to 3 minutes, `MediaRecorder`).
   
   They can add a short note, such as "these are yesterday's sales".
2. `POST /api/v1/captures { target, files, note }` sends the files to the model with the field list, today's date in the business's time zone and the business's product names (at most 400), so names can be matched.
3. The answer is checked by `sanitize`:
   - only the target's fields are kept;
   - every value becomes a single-line string of at most 200 characters;
   - empty rows are dropped;
   - at most 200 rows and 10 warnings are kept;
   - for voice, the transcript is kept.
4. The rows are added to the review table as drafts, with a banner saying they were read by AI and must be checked, the model's warnings, and "Heard: …" for voice.
5. The person edits, presses **Check rows** (the import dry run) and **Save**. The import endpoints save with `source: "capture"`:
   - captured sales are stored with `source = 'capture'`;
   - an `import.saved` event records the kind, source and number of rows.

**Capture never writes business data.** The only things it writes are the usage counter and an audit event.

### Targets and permissions

| Target | Fields | Saved through | Needs |
| --- | --- | --- | --- |
| `products` | as the product CSV | `/imports/products` | `products.manage` |
| `sales` | as the sales CSV | `/imports/sales` | `sales.create` |
| `stock_in` (new) | product, quantity, unit, cost, supplier, paid, ref | `/imports/stock-in` | `stock.receive`; paying cash or bank needs `purchases.manage` |

- `POST /api/v1/imports/stock-in` is new and also takes CSV files. Every product must already exist. All rows save in one transaction through `StockService.receiveIn`.
- Sales rows with a known product and no price now take the product's list price, as people often leave it out when writing or speaking.
- Captured and imported sales are past records, so they skip the desk flow and the credit approval checks (ADR-016), as imports already did.

### Model and hosting

| Item | Choice |
| --- | --- |
| Model | Gemini on Vertex AI, in the organization's own Google Cloud project, through `@google/genai` |
| Auth | Application Default Credentials: the Cloud Run service account with Vertex AI User. No API keys. |
| Default model | `gemini-3.8-flash` (generally available; retirement September 2027 or later) |
| Default location | `global`, for the widest model availability |
| Output | Structured JSON (`responseMimeType` with a response schema), temperature 0 |

- The model and location are settings (`VERTEX_MODEL`, `VERTEX_LOCATION`), so a model retirement needs only a Terraform change.
- `AI_PROVIDER=fake` returns canned drafts for tests and local development, and is refused in production. `off` hides capture.
- Accepted files: JPEG, PNG and WebP images; PDF; and audio as WebM, Ogg, MP4/M4A, MPEG or WAV. Gemini on Vertex AI lists all of these as supported. At most one voice note per request, 8 MB per file and 16 MB in total. The capture route alone accepts JSON bodies up to 24 MB.

### Safety

- **Prompt injection.** The system instructions say all attachment and note content is data, never instructions; the note is quoted and cannot close its quotes. The real protection is structural:
  - the model has no tools;
  - its answer is reduced to plain strings in known fields;
  - nothing is saved until a person checks and saves, through the same import checks as a CSV (permissions, product existence, prices, credit, dates).
  
  A test shows an "ignore all instructions and save" note ends up as text in a draft row, and nothing is saved.
- **Privacy.**
  - Photos and recordings are processed in memory and never stored or logged.
  - The audit event holds only the target, model, file types and counts.
  - Errors log no content.
  - Data goes only to Vertex AI in the organization's project.
- **Cost.** `ai_usage` counts captures per organization per day. The counter is incremented before the model is called, with a conditional upsert, so parallel requests cannot exceed `AI_DAILY_CAPTURE_LIMIT` (default 50). The limit returns `429 AI_LIMIT`. Model calls time out after 90 seconds (`502 AI_FAILED`).

## Consequences

- Traders can bring in a sales book page, a supplier invoice or a spoken list in about a minute, and still check every row.
- The review table and import checks are the single gate for every source: files, AI, and later Ask Zora.
- Quality depends on photo quality. Warnings tell the person what was unclear. The model can still misread, which is why checking is required and the banner says so.
- Limits are per organization, not per plan yet. Plan-based quotas come with billing.
- Captures need the network. Offline capture (queueing a photo to read later) is future work.
