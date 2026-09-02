# Aime — character brief

For whoever makes the character: an illustrator, a 3D artist, or the person at
the keyboard with VRoid Studio open. Everything needed to quote and deliver is
here; nothing in it depends on reading the code.

## What ships today, and how to replace it

`public/splash/aime.webp` is a **placeholder**, not the finished Aime, and it is
one command away from being replaced.

- **Who she is:** "Vita", one of VRoid Studio's own sample avatars. Chosen
  because her palette is almost exactly the app's accent blue.
- **Licence: CC0**, commercial use `Allow` — read out of the model file's own VRM
  metadata rather than off a web page, which is also what
  `scripts/render-portrait.mjs` does before it will write anything.
- **Where the model came from:**
  `https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/beta/Vita.vrm`
  (SHA-256 `f2bf78f28a24e2f75f5ca0b6c3b646654c394e4b03592dfaa0d0633ef0972b4d`).
  The `.vrm` is deliberately not committed - 14 MB of source asset for a 1.5 MB
  render - so re-rendering starts by fetching it again.
- **What she already does:** the greeting above is not waiting for an artist -
  it is animated on the shipped model, from the humanoid rig, by
  `scripts/portrait/render.html`. A replacement model inherits all of it.
- **To replace her:**

  ```
  npm run render:portrait -- --model path/to/aime.vrm
  ```

  Any VRM or rigged GLB works. The camera and the stance are computed from the
  model's own humanoid bones, so a different body needs no numbers changed. Add
  `--frames 1 --still review.png` to check a pose without rendering a loop.

- **What she is not:** the brief below. She is slim, she is somebody else's
  character, and she was picked for her licence and her colours. Getting the
  Aime described below means either VRoid Studio (free, slider-driven, and the
  body is yours to set) or a commission.

## Who this document is for

The sections below describe the Aime to be made, for an artist to work from.

## What it is for

Aime is an AI-first desktop code editor. This character **is** Aime: she appears
in the transparent splash window at every launch, on the right-hand side of a
720 × 400 card, for a minimum of 1.4 seconds. She will also be the face of the
README, the website and the installer.

That is the whole use: a few seconds, at close range, on a near-black panel, seen
by a developer several times a day. It has to be worth seeing the tenth time,
which rules out anything busy.

## Who she is

An adult woman, mid-twenties, and the app's collaborator rather than its mascot:
the one who actually does the work while you watch. Confident and competent, with
a trace of amusement — she has already read your codebase. Not cute, not a
receptionist, not a robot: no visible circuitry, no glowing eyes, no headset.

## Look

**The target is alluring and stylish — editorial, not pin-up.** Attractive is the
point; explicit is not, and the difference here is deliberate and non-negotiable
because this ships inside a professional developer tool.

- **Pose** — standing, weight on one hip, three-quarter turn towards the viewer,
  eyes to camera. Relaxed hands. A confident stance, not a presented one.
- **Wardrobe** — modern and sharp: an unbuttoned blazer or an oversized shirt with
  sleeves rolled, a fitted top under it, high-waisted trousers or a pencil skirt.
  Well cut and close-fitting is right; the appeal should come from the silhouette
  and the confidence, not from how little there is.
- **Not this** — no lingerie or swimwear, no exposed underwear, no cleavage as the
  focal point, no arched back or presented hips, no crop that centres on the body,
  no wet or torn clothing, no upskirt or low camera angle.
- **Hair** — long enough to move; it is one of the few things that will be animated.
- **Framing** — head to mid-thigh, anchored to the bottom edge of the canvas, facing
  into the card so she reads as standing beside the wordmark rather than in front
  of it. Leave her right side (viewer's left) uncluttered: the words go there.
- **Rendering** — clean semi-realistic anime, soft cel shading, visible line only
  where it helps. Rim light from the upper left in the accent blue below, so she
  sits in the same light as the card; the card is dark, so she must not be dark.

## Palette

The app's own tokens. Accent blue is hers; the rest is the ground she stands on.

| Role               | Hex       |
| ------------------ | --------- |
| Accent (rim light) | `#6c8cff` |
| Accent, deep       | `#4c5fd7` |
| Card background    | `#16181d` |
| Border / separator | `#2b303a` |
| Text               | `#d7dae0` |
| Muted text         | `#8b919d` |

Skin and hair may sit outside the palette; anything worn or carried should stay
inside it, or in neutral greys, so she never fights the UI behind her.

## Deliverables

1. **Layered PSD**, 900 × 1080 px, 72 dpi, sRGB, transparent background. Layers
   grouped and named in English, separated for rigging — at minimum: hair front /
   hair back / face base / eyes (whites, iris, highlight) / eyebrows / eyelids /
   mouth / head / torso / each arm / each leg / each garment / accessories. Nothing
   merged, no clipping masks that flatten to nothing.
2. **Flat PNG**, same canvas, transparent, for review and for the fallback still.
3. **Expression variants** (optional, priced separately): neutral, faint smile,
   focused. Only if we later show her state while the AI is working.

If you also rig:

4. **Live2D Cubism model** with the idle animation below.
5. **Exported animated WebP with alpha**, 662 × 800 px, seamless loop, ≤ 2 MB.
   Exported from the Cubism Editor — the app plays the file and embeds no Live2D
   runtime, which is deliberate on our side.

## Idle animation

One seamless loop, five seconds, no cut visible at the join, no audio. She is
greeting somebody, not standing in a shop window, and the loop has beats:

1. **She notices you** - the head comes up, the eyes find the lens, a flicker of
   surprise under the smile.
2. **She waves** - the near arm comes up, hand open beside her face, palm to
   camera, and rocks twice. The body answers it: the shoulder lifts, the weight
   shifts, the head tilts. An arm that moves alone belongs to a puppet.
3. **She bows** - a small dip forward from the waist and back up. What she must
   not do is look away: a glance off towards the wordmark was tried and rejected,
   because the loop then ends with her eyes off the viewer.
4. **She shrugs** - both shoulders up, head tilted: "so, what are we working on".
5. **She nods** - twice, small, the way somebody says "ready when you are". This
   is what closes the loop.

Under all five, always: breathing in the chest and shoulders; hair drifting, back
hair lagging behind the front; a barely-there shift of weight; and blinks, uneven,
one of them a double, none of them during the wave.

**Make the gestures readable.** The portrait is shown about 310 px wide, and
motion authored to be tasteful at full size disappears there - the first pass of
this loop was measured at a degree and a half of movement and read as a
photograph. If it looks slightly too much in the editor, it is close to right on
the card.

## Her voice, and what it is licensed under

She says hello out loud on the starting window. That is a **shipped audio file
per language**, not the machine's own speech synthesiser: Windows installs a
different set of voices on every computer, and measured on one of ours there was
no female Vietnamese voice at all. A file sounds the same everywhere.

Rendered offline with [Piper](https://github.com/rhasspy/piper) (MIT), then pitched up 35% by
synthesising slower and playing faster - which lifts the formants too, and that is what reads as a
young voice rather than a fast one. Measured: 267 Hz for English, 298 Hz for Vietnamese.

| File                            | Voice                   | Dataset licence                                                       |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `public/splash/greeting-en.wav` | `en_US-ljspeech-medium` | [LJ Speech](https://keithito.com/LJ-Speech-Dataset/) - public domain  |
| `public/splash/greeting-vi.wav` | `vi_VN-vais1000-medium` | VAIS-1000 - [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

### What this voice is not, and what it would take

It is an adult woman reading, pitched up. It is not the young, anime-ish voice
the character is written for, and no processing makes it one: pitch and formants
are already at the ceiling, and what is left is the speaker in the dataset.

Every free Vietnamese alternative was checked. `vivos` forbids commercial use;
`25hours_single` states no licence; `viXTTS`, `XTTS-v2` and `F5-TTS` - the models
that do sound the part - are all non-commercial. `VietTTS` is Apache-2.0 in its
code but its published weights say only "cc", and some of its built-in voices are
clones of named public figures, which is a separate problem again. Getting the
intended voice means either a licensed commercial Vietnamese TTS or three seconds
of a real person; the wording is written to carry as much of it as words can.

**The Vietnamese voice is CC BY 4.0, so the credit above travels with the app** -
keep it in this file and in whatever the release notes or the about box become.
Piper's other Vietnamese voices were rejected on licence: `vivos` forbids
commercial use and `25hours_single` states its licence as "Unknown".

To render them again:

```
npm run render:greeting -- --piper path/to/piper.exe   --voice-en path/to/en_US-ljspeech-medium.onnx   --voice-vi path/to/vi_VN-vais1000-medium.onnx
```

Piper and the two voice models are ~150 MB and deliberately not committed; the
402 KB of audio they produce is.

## Rights we need

- Worldwide, perpetual, irrevocable licence to **use, reproduce, modify and
  distribute** the artwork as part of the Aime application, its installers, its
  website, its store listings and its marketing.
- The right to have the artwork rigged and animated by a third party.
- Exclusivity: the character is not resold or reused for anyone else. Portfolio
  and process-sharing rights stay with you.
- Please state whether any part of the work was AI-generated, and which part. It
  is not automatically disqualifying, but purely AI-generated output may not be
  copyrightable, and we need to know what we are buying.

## Where to send

Rough sketch and a quote first, please — pose, framing and wardrobe direction on
one page is enough to agree before any rendering.
