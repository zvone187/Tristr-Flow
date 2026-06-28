# Speak Selection — In-page (Chrome extension)

Highlights the **actual text on the page**, karaoke-style, as it's read aloud —
and the highlight stays glued to the words as you scroll (it uses Chrome's CSS
Custom Highlight API, so there's no DOM rewriting).

It talks to the **Speak Selection app** over `127.0.0.1:8757` (the app holds your
ElevenLabs key and does the streaming), so the key never lives in the browser.

## Requirements

- The **Speak Selection app must be running** (it provides the local bridge).
- Chrome/Edge 105+ (for the CSS Custom Highlight API). Chrome 128+ recommended.

## Install (load unpacked)

1. Open **chrome://extensions**
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select this `extension/` folder
4. (Optional) Open **chrome://extensions/shortcuts** and set/confirm the shortcut
   for *“Read the selected text aloud with in-page highlighting.”* Default is
   **⌃⇧Y** (Control+Shift+Y) on macOS — change it to whatever you like.

## Use

1. Select text on any web page.
2. Press the shortcut (or click the extension's toolbar icon).
3. It reads aloud and highlights each word **in place**; scroll freely — the
   highlight follows the text. A small pill (bottom-center) has **play/pause**
   and **stop** (Esc also stops).

> If audio doesn't auto-start (some sites block autoplay), click the **▶** on the
> pill once — the browser then allows playback.

## Notes

- Uses the **voice and stability** you've chosen in the app's Preferences.
- Long selections are auto-split under the model's limit and streamed
  continuously — no length cap.
- This is the **browser-only** counterpart to the app's floating overlay; for
  Claude, PDFs, and native apps, keep using the app's global hotkey + overlay.
- The bridge is localhost-only and gated by a shared token, so other web pages
  can't reach it.
