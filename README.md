#  Mixing Engineer by Palace Audio

A Max for Live device that listens to your mix and answers questions about it. Drop it on the master track, ask it what's going on, get specific feedback grounded in actual measurements of your audio — frequency balance, dynamics, masking, loudness, the works.

It's not a replacement for ears. It's a second opinion you can ask things like "is the kick fighting the bass in the drop?" or "does my mix sound finished?" — and it'll tell you, with numbers.

## Rationale and Philosophy

I believe that mixing music is a skill (objective) and an art (subjective) at the same time. In the countless hours that I taught myself producing, I realized that achieving the sound I wanted required **applying the objective to the subjective** - especially in dance music. 

I navigated the producer journey with every tool available to me: video tutorials, webpages & blogs, mentors & established producers, and finally, artificial intelligence. In my experience, information is abundant but the more detailed my questions were, the less I was able to benefit from any one source.

I am proud to say that I can take care of myself now :) but I also realize that many producers have the mindset of an artist without the skillset. I say this confidently because I used to be one of them. At a time when music production is so accessible, I was unable to find a single reliable technique to teach myself production. This is why I built a tool that **bridges the gap between skill and art.**

I am most proud of this because it embodies how I view artificial intelligence: that it has immense potential to help humans when used to complement rather than clash with our interests. The beauty of my product is that it is both an **educational tool** that understands newer producers even if they don't have the words for what they hear, but also an **advanced mixing analysis tool** that rewards a pro's nuanced questions with deep analysis. I worked with trusted producers and mixing engineers to ensure that it has access to all the information a professional would need to make decisions.

I purposefully limited my tool to be purely advisory and did not give it any editing capabilities. My goal is to provide a platform for thought-provoking questions about mixing without taking away from the creative experience. I hope I was able to provide this!

- Alp Isbir

## How to use it

Open the chat panel and ask in plain language. There's no syntax to learn — talk to it the way you'd talk to another producer. The device picks the right tools and answers from actual measurements.

The chat keeps full conversation history within a session, so you can ask follow-up questions, push back on an earlier verdict, or move between tracks freely. You can also ask general mixing questions that don't require a measurement — the device draws on standard mixing knowledge for those.

## Functionality

**Listen to a section.** Captures audio between any two locators (or ten seconds from the playhead) and reports frequency balance, peak and RMS levels, integrated LUFS, true peak, dynamic range, stereo correlation, and a per-second spectrum and energy timeline.

**Inspect specific tracks.** Name up to eight tracks and the device taps each in parallel — full spectrum, RMS over time, active automation, and live gain reduction from compressors and limiters.

**Diagnose masking and sidechain.** Cross-checks spectral overlap against temporal energy correlation to distinguish masking (two tracks loud together in overlapping bands) from sidechain ducking (anti-correlated energy), and reports each duck's depth and recovery.

**Check stereo, phase, and mono compatibility.** Measures each track's stereo image and width, flags phase cancellation between elements (the usual culprit behind a weak low end when kick and sub fight), and tests how the mix survives summed to mono.

**Catch transients and resonances.** Reports per-band onset density and decay times — punchy vs. sustained — and flags ringing resonances anywhere in the spectrum, with no fixed "harsh" band.

**Read device chains.** Walks every device on every track, including nested chains inside Effect Racks. Reports what each chain is doing audibly — which EQ bands are doing work, where a compressor is actually pulling, whether a saturator's dry/wet renders it inaudible.

**Compare to a reference.** Select a reference track and ask how your mix differs from it — comparison is loudness-normalized, so it's content, not level.

**Mix vs. master state awareness.** Detects whether your mix is still in progress or already mastered from integrated LUFS, true peak headroom, and crest factor.

**Per-project memory.** Holds the intent of the track: genre, mood, references, target loudness. The device reads this at the start of each session.

**What it won't do.** Make changes for you. Confirm what you already think. Replace your ears.

## Installation

1. Download the latest `.amxd` from the [Releases page](#) (link will appear once a release is published).
2. Drag the `.amxd` onto the **master track** of your Ableton Live set.
3. Open the device. The first time, choose your model provider and enter its key (see below).

## Choosing a model

You supply the AI model that does the analysis, so any cost lands on your account, not someone else's. Open settings (⚙) and pick a provider:

- **Anthropic (Claude)** — paste a key from console.anthropic.com (`sk-ant-…`). Sharpest analysis.
- **OpenRouter** — one key for many cloud models; the path when your machine can't run a large model locally.
- **Local (Ollama / LM Studio)** — runs on your own machine: free per question, no key, but needs a capable model and the RAM to hold it.

The running cost — or **free**, for local — shows in the corner of the chat panel.

## Privacy and cost

- **Your API key is stored on your computer only**, in this device's local browser storage as plain text — the trade-off for a bring-your-own-key tool that runs with no server of its own. It never leaves your machine except to call your chosen provider directly. To remove it, clear the device's settings, or use a local provider (Ollama / LM Studio), which needs no key at all.
- **Audio is summarized into numbers before being sent.** The model sees frequency balance, peak levels, and the like — never the raw audio.
- **You pay your provider directly**, or nothing if you run a local model. No subscription to anyone else.

## Project memory

Each Live set you use the device with has its own small memory note. The device uses it to remember the *vibe and intent* of the track — genre, mood, references, the loudness you're aiming for. It does **not** remember what changes were made or what was measured (those expire). The memory travels with the Live set's name on this machine; it doesn't follow the set to other computers.

## Troubleshooting

- **Chat panel is blank.** The device couldn't reach the UI hosted on GitHub Pages. Check your internet connection. If you're offline, the device won't work — the UI is fetched fresh each time.
- **Status stays red / "Offline".** Click the gear icon top-right, pick your provider, and enter its key.
- **Responses time out.** Open Max Console in Ableton (View → Max Window) and look for red errors. Most often this is the device losing its connection to the Live set — close the set and reopen.

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE). The source is public so the device can run (its interface is served from this repository) and for transparency, but it is **not** open source: you may not copy, clone, fork, reuse, redistribute, modify, or monetize the code or its prompts without written permission.

## Credits

Built by Alp Isbir. Powered by Claude (Anthropic) or any OpenAI-compatible model. Uses Max for Live (Ableton + Cycling '74).
