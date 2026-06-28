# Speak Selection 🔊

A tiny macOS menu-bar app. Select text **anywhere** — a browser, your terminal,
Claude Code, a PDF — press the hotkey, and it reads the selection aloud with an
ElevenLabs voice while a floating overlay **karaoke-highlights the exact word
being spoken**.

## How it works

1. **Hotkey** — `⌃ Control + ⇧ Shift + Space` (or `⌃ Control + ⌥ Option + D`), global, works in any app.
2. **Capture** — grabs the current selection from the frontmost app, then
   restores your clipboard so nothing is lost. It first presses the app's
   **Edit → Copy** menu item via Accessibility (works in Chrome, Safari, native
   apps and is immune to held modifier keys), and falls back to a clean
   synthetic ⌘C for apps with non-standard menus. (See *Chrome note* below.)
3. **Speak (streaming)** — the text goes to ElevenLabs' `stream/with-timestamps`
   endpoint. Audio **starts playing before the whole thing is generated**, with
   per-character timings arriving alongside.
4. **Highlight** — a frameless always-on-top overlay plays the audio and lights
   up each word in sync, auto-scrolling as it reads.

**Controls while it's open:**
- **Play/Pause** — the ❚❚/▶ button, or the **Space** key.
- **Click any word** to jump there and play from that point (within what's been
  generated so far).
- **Scroll** freely through long text.
- **Stop** — click **✕**, press **Esc**, or press the hotkey again (hard-stops
  audio instantly, even mid-stream, and aborts the request to save credits).

### Length: effectively unlimited

There's no 5000-character limit. Long selections are split into back-to-back
streamed requests, stitched into one continuous audio timeline with the
highlight kept in sync — read whole articles.

### Two triggers

`Control+Shift+Space` and `Control+Option+D` both work. (You asked for "W+D" —
a bare two-letter chord can't be a global shortcut and would misfire constantly
while typing or gaming, so it's a modifier-anchored `⌃⌥D` instead; change it via
`SPEAK_HOTKEY2`.)

### Voice, stability & speed

Open **Preferences — Voice & Stability…** from the menu-bar menu (or ⌘,):

- Pick from a list of voices — the two **Hope** voices are pinned at the top
  (default: *Hope — Clear, Relatable & Charismatic*), followed by your full
  ElevenLabs library. **▶ Preview** any voice before choosing.
- **Stability** (Creative / Natural / Robust) — the one setting the v3 model
  actually honors. Lower = more expressive but can sound *weird/unstable*;
  higher = steadier. **If a voice sounds off, bump it to Natural or Robust.**
  Default is Natural.
- **Speed** (0.7× – 1.2×) works on older models but is **ignored by v3**, so it's
  greyed out while v3 is the active model.
- Choices persist across restarts. Quick switches are also in the menu-bar menu.

> **Emotion?** In v3, emotion is steered by inline tags in the *text* (e.g.
> `[excited]`, `[whispers]`). That's for content you author — it doesn't apply to
> reading arbitrary selected text (and the tags would show up in the highlight),
> so the app reads your selection verbatim. Use **Stability** to set the overall tone.

### Chrome note

Earlier the synthetic ⌘C failed in Chrome: when the hotkey fired you were still
holding Control+Option, and macOS OR-merges those live modifiers into the
synthetic event, so Chrome received Ctrl+Opt+⌘C and ignored it (native apps are
lenient, which is why it worked elsewhere). The fix presses **Edit → Copy**
directly via the Accessibility API — no keystroke, no modifier contamination —
and only falls back to ⌘C after the held keys clear.

### Why a floating overlay (and not highlighting in-place)

macOS gives no reliable, app-agnostic way to draw on top of another app's
*actual* text (we'd need each app's accessibility geometry, which is fragile and
often unavailable). So instead the overlay shows the captured text in a
teleprompter-style panel and highlights the current word there. It works
identically no matter which app the text came from.

## First run

The API key is read automatically from `~/Development/pazi/api/.env`
(`ELEVENLABS_API_KEY`). Nothing to configure.

### Run from source

```bash
npm install
npm start
```

A 🔊 icon appears in the menu bar. Select text, press **⌃⇧Space**.

### macOS permissions (required once)

Reading the selection (pressing Edit → Copy / sending ⌘C) needs **Accessibility**
permission:

- **System Settings → Privacy & Security → Accessibility** → enable the app
  (or "Terminal"/"Electron" when running from source).

> **After each rebuild** the unsigned app gets a new identity, so macOS forgets
> the grant — remove the old "Speak Selection" entry and re-add the new one if
> capture suddenly stops working.

The menu-bar menu shows whether the permission and API key are detected, and has
a **"Read clipboard text aloud"** item to test without granting Accessibility.

## Build an installable app

```bash
npm run dist
```

Produces a `.dmg` (and `.zip`) in `dist/`. Open the DMG and drag the app to
Applications.

> The build is **unsigned**, so the first launch needs right-click → **Open** to
> get past Gatekeeper, and you must re-grant Accessibility after each rebuild
> (an unsigned app gets a new identity each time).

## Config

All optional — see [.env.example](.env.example). You can change the voice,
model, hotkey, and max length via a `.env` next to the app or real env vars.

## Files

| File | Role |
| --- | --- |
| `src/main.js` | App lifecycle, global hotkey, tray, orchestration |
| `src/selection.js` | Captures the current selection via ⌘C (clipboard-safe) |
| `src/elevenlabs.js` | Calls the ElevenLabs with-timestamps TTS endpoint |
| `src/overlay.{html,css,js}` | The floating karaoke overlay |
| `src/config.js` | Loads the API key + settings |
| `src/preload.js` | Secure IPC bridge to the overlay |
