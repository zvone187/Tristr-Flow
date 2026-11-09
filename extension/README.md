# Tristr Flow in-page reader

The Chrome extension reads selected text and highlights each word on the page. It uses the voice, account and credits of the signed-in Tristr Flow desktop app. The desktop app sends each speech request to the Tristr Flow backend and keeps the account token out of the browser.

## Install or update

1. Install Tristr Flow 0.1.7 or later and sign in to the desktop app.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge and turn on **Developer mode**.
3. Choose **Load unpacked** and select the updated `extension/` folder. Browser version 105 or later supports the CSS Custom Highlight API used by the reader.
4. If you previously installed an unpacked copy, remove the old extension entry after loading the updated folder. The current extension ID is `jllpigimfnadoijjooemcapddkfpafjd`. The desktop app accepts this ID for reading requests. An old copy can display “Bridge error 403” after a desktop update.
5. Reload any tabs where you want to use the extension. If you customized your keyboard shortcut, set it for the new extension in `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`.

## Read a selection

Select text on a web page, then click the extension’s toolbar button or press **Control+Shift+Y**. The toolbar in the page offers play, pause and stop. Esc also stops the stream. If the browser blocks autoplay, press the play button. Keep the desktop app running while reading.

The app streams long selections in segments and checks available credits on the backend. Sign out in the desktop app to stop new extension reads on that account.
