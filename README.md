#  Mixing Engineer by Palace Audio

A Max for Live device that listens to your mix and answers questions about it. Drop it on the master track, ask it what's going on, get specific feedback grounded in actual measurements of your audio — frequency balance, dynamics, masking, loudness, the works.

It's not a replacement for your ears — it's an experienced second opinion, always there on your shoulder.

## Rationale and Philosophy

I believe that mixing music is a skill (objective) and an art (subjective) at the same time. In the countless hours that I taught myself producing, I realized that achieving the sound I wanted required **applying the objective to the subjective** - especially in dance music. 

I navigated the producer journey with every tool available to me: video tutorials, webpages & blogs, mentors & established producers, and finally, artificial intelligence. In my experience, information is abundant but the more detailed my questions were, the less I was able to benefit from any one source.

I am proud to say that I can take care of myself now :) but I also realize that many producers have the mindset of an artist without the skillset. I say this confidently because I used to be one of them. At a time when music production is so accessible, I was unable to find a single reliable technique to teach myself production. This is why I built a tool that **bridges the gap between skill and art.**

I am most proud of this because it embodies how I view artificial intelligence: that it has immense potential to help humans when used to complement rather than clash with our interests. The beauty of my product is that it is both an **educational tool** that understands newer producers even if they don't have the words for what they hear, but also an **advanced mixing analysis tool** that rewards a pro's nuanced questions with deep analysis. I worked with trusted producers and mixing engineers to ensure that it has access to all the information a professional would need to make decisions.

I purposefully limited my tool to be purely advisory and did not give it any editing capabilities. My goal is to provide a platform for thought-provoking questions about mixing without taking away from the creative experience. I hope I was able to provide this!

- Alp Isbir

## How to use it

Open the chat panel and talk to it the way you'd talk to another producer. The device picks the right tools and answers back from actual measurements.

The chat keeps full conversation history within a session, so you can ask follow-up questions, push back on an earlier verdict, or move between tracks freely. You can also ask general mixing questions that don't require a measurement — the device draws on standard mixing knowledge for those.

## Getting the best out of it

**Set the intent.** It asks for genre, references, and target loudness the first time you open it on a project; after that, just say what each element is meant to do as you go and it tracks it.

**Name tracks for what they are.** Clear track names (kick, sub, lead vocal) keep it from misreading what it's looking at.

**Ask specific questions.** A precise question about a band, an element, or a moment beats "is this good?"

**Push back.** If a verdict doesn't sit right, ask how it got there.

## Functionality

**Listen to a section.** Captures any part of your mix — a section between two locators, or a default window from the playhead — for analysis.

**Inspect specific tracks.** Name up to eight tracks and it analyzes each one individually, in parallel.

**Frequency balance.** Reads the tonal balance across the spectrum and the resonant peaks that stand out from it.

**Dynamics.** Measures dynamic range, transient attack, and decay.

**Masking.** Identifies where two elements compete in the same frequency range, and how much one covers the other.

**Stereo, phase, and mono.** Measures each element's stereo width and placement, detects phase cancellation between elements, and tests how the mix holds up summed to mono.

**Read device chains.** Walks every device on every track, including nested racks, and reports what each one is doing to the signal.

**Compare to a reference.** Pick a reference track and compare your mix against it.

**Loudness and headroom.** Measures integrated loudness and true peak.

**Per-project memory.** Remembers each project's genre, references, and target loudness, and what each element is meant to do.

**More than a meter.** Any plugin can show you these numbers. Here they power an AI — which is what makes it a mixing engineer.

## Installation

1. Download the latest `.amxd` from the [Releases page](#) (link will appear once a release is published).
2. Drag the `.amxd` onto the **master track** of your Ableton Live set.
3. Open the device. The first time, choose your model provider and enter its key (see below).

## Choosing a model

You supply the AI model that does the analysis. Open settings (⚙) and pick a provider:

- **Anthropic (Claude)** — Default is the newest Opus model.
- **OpenRouter** — one key for many cloud models, Deepseek-v4-flash is recommended for cost/efficiency.
- **Local (Ollama / LM Studio)** — runs on your own machine: free per question.

- The running cost, alongside token usage, shows in the corner of the chat panel.

## Privacy and cost

- **Your API key is stored on your computer only**, in this device's local browser storage as plain text. It never leaves your machine except to call your chosen provider directly. To remove it, clear the device's settings.
- **You pay your provider directly**, or nothing if you run a local model.


## Project memory

Each Live set gets its own memory note, stored on this machine — it travels with the set's folder but doesn't follow it to another computer. It holds the track's intent only; the changes you made or the numbers it measured expire each session.

## Troubleshooting

- **Chat panel is blank.** The device couldn't reach the UI hosted on GitHub Pages. Check your internet connection. If you're offline, the device won't work (WIP)
- **Status stays red / "Offline".** Click the gear icon top-right, pick your provider, and enter its key.
- **Responses time out.** Most often this is the device losing its connection to the Live set — close the set and reopen. It could also be an AI provider timing out - try repeating your question, or tell the AI you never got an answer.

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE). The source is public for transparency and educational purposes, but it is **not** open source: you may not copy, clone, fork, reuse, redistribute, modify, or monetize the code or its prompts without written permission.

## Credits

Built by Alp Isbir. Powered by artificial intelligence. Uses Max for Live (Ableton + Cycling '74).
