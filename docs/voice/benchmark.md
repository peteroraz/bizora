# Offline voice benchmark (ADR-041)

Run by `.github/workflows/voice-benchmark.yml` with `apps/web/scripts/voice-benchmark.mjs`. Push a `bench/voice*` branch or start the workflow by hand. It never runs on pull requests.

## What it measures

- **Nigerian English.** 31 read-out sentences, one per speaker, female and male, recorded in Lagos and London. They come from OpenSLR SLR70 (Google, CC BY-SA 4.0), are used for this test only and are not shipped.
- **Spoken sales.** 12 trader sentences (rice, Indomie, Peak Milk, credit, split payments, POS, customer names), each made with espeak-ng in three accents (US, Caribbean, Scottish). That gives 36 recordings. espeak-ng is a robot voice, not a Nigerian accent.
- **Conditions.** Each recording is tested as recorded and again with crowd noise mixed in: three other speakers at 5 dB (round 1) or 10 dB (round 2) below the speech.
- **Scores.**
  - **Words wrong (WER):** numbers are counted as words, so "75,000" equals "seventy five thousand". It can exceed 100% when a model runs on.
  - **Sales read right:** Bizora's parser reads the same items, quantities, prices, customer and payment from the model's words as from the true words.
  - **Speed:** seconds per second of audio on a GitHub runner's processor (Node, 4 cores). A phone is slower; compare models with each other.

## Round 1 (22 Nov 2026, crowd at 5 dB)

| Model | Download (MB) | Nigerian English % | + crowd % | Sales % | + crowd % | Sales right (clean / crowd) | Speed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| whisper tiny.en (shipped in ADR-040) | 64 | 21.6 | 339.1 | 39.8 | 512.7 | 2/36 / 0/36 | 0.08 |
| whisper base.en | 136 | 14.6 | 57.3 | 34.9 | 487.1 | 1/36 / 0/36 | 0.13 |
| whisper base.en q8 | 77 | 15.7 | 57.8 | 36.8 | 348.1 | 2/36 / 0/36 | 0.13 |
| whisper base.en + prompt | 136 | 14.6 | 51.0 | 26.9 | 519.7 | 10/36 / 0/36 | 0.14 |
| whisper base.en, 4 beams | 136 | 14.6 | 57.3 | 34.9 | 487.1 | 1/36 / 0/36 | 0.13 |
| whisper base (multilingual, English) | 136 | 16.2 | 133.7 | 40.2 | 371.9 | 1/36 / 0/36 | 0.13 |
| whisper small.en q8 | 249 | 12.6 | 38.7 | 23.6 | 411.9 | 5/36 / 0/36 | 0.27 |
| whisper small.en q8 + prompt | 249 | 12.4 | 35.1 | 9.6 | 249.9 | 19/36 / 1/36 | 0.29 |
| distil small.en q8 | 172 | 13.7 | 50.8 | 25.3 | 182.8 | 6/36 / 0/36 | 0.25 |
| moonshine tiny | 51 | 16.6 | 77.1 | 39.4 | 115.0 | 2/36 / 0/36 | 0.02 |
| moonshine base | 123 | 10.1 | 62.5 | 27.1 | 81.5 | 7/36 / 0/36 | 0.04 |

## Round 2 (22 Nov 2026, crowd at 10 dB, output capped to the recording's length)

| Set-up | Download (MB) | Nigerian English % | + crowd % | Sales % | + crowd % | Sales right (clean / crowd) | Speed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| whisper tiny.en (shipped in ADR-040) | 64 | 21.6 | 110.8 | 39.8 | 337.0 | 2/36 / 0/36 | 0.08 |
| **whisper base.en q8 + prompt + cap (Standard)** | 77 | 15.7 | 28.3 | 28.1 | 63.0 | 10/36 / 1/36 | 0.14 |
| **whisper small.en q8 + prompt + cap (Best accuracy)** | 249 | 12.4 | 20.2 | 9.6 | 47.0 | 19/36 / 2/36 | 0.30 |
| moonshine base + cap | 123 | 10.1 | 33.0 | 27.1 | 51.7 | 7/36 / 0/36 | 0.03 |

## What it showed

- **Size helps.** Accents are read better as the model grows: tiny 21.6%, base 15.7%, small 12.4% of words wrong. With 8-bit weights, base is almost as good (15.7% against 14.6%) at about half the download.
- **The shop prompt helps most with sales.** It makes Whisper expect "naira", product names and customer names. Sales read right went from 1 to 10 of 36 for base and from 5 to 19 for small; the prompt did not hurt on other sentences.
- **The length cap stops runaway output** in noise, where tiny wrote the same words over and over: 339% became 110.8%.
- **Beam search** made no difference with this library and was left off.
- **Moonshine base** was best on clean sentences and is very fast, but it can't take a prompt and did worse on sales and in noise. It is worth looking at again if the library adds prompting for it.
- **No model reads sales well in loud crowd noise.** The review step and typing stay essential, and traders should hold the phone close.

## Not measured

- Real traders saying real sales on real phones, in markets.
- Speed and memory on low-end Android, and the effect of WebGPU.
- Pidgin, Igbo, Yoruba and Hausa.
