'use strict';

// Local Chromium/renderer QA for the real overlay page, preload, sanitizer, and CSS.
// No provider request or system clipboard write occurs.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { readClipboardContent } = require('../src/clipboard-content');

const root = path.resolve(__dirname, '..');
const screenshots = path.join(__dirname, 'qa-screenshots');
const table = '<p>Here is the table.</p><table><thead><tr><th>Options selected</th><th>Users</th><th>Share</th></tr></thead><tbody><tr><td>1</td><td>160</td><td>17.7%</td></tr><tr><td>2</td><td>85</td><td>9.4%</td></tr></tbody></table><p>After the table.</p>';
const wide = '<p>Wide table:</p><table><tbody><tr>' + Array.from({ length: 9 }, (_, i) => '<th>Column ' + (i + 1) + '</th>').join('') + '</tr><tr>' + Array.from({ length: 9 }, (_, i) => '<td>Value ' + (i + 1) + '</td>').join('') + '</tr></tbody></table>';
const hostile = '<p>Safe intro</p><table onclick="window.pwned=1"><tr><th>Header</th><td><img src="https://example.invalid/track"><script>window.pwned=1</script><a href="https://example.invalid/path" onmouseover="window.pwned=1">Safe cell</a></td></tr></table>';

async function inspect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#text');
    const wrapper = root.querySelector('.table-scroll');
    return {
      text: root.textContent,
      tableCount: root.querySelectorAll('table').length,
      rows: [...root.querySelectorAll('tr')].map(row => [...row.children].map(cell => ({
        tag: cell.tagName, text: cell.textContent,
        x: Math.round(cell.getBoundingClientRect().x),
        y: Math.round(cell.getBoundingClientRect().y)
      }))),
      overflowX: wrapper ? getComputedStyle(wrapper).overflowX : null,
      scrollWidth: wrapper ? wrapper.scrollWidth : 0,
      clientWidth: wrapper ? wrapper.clientWidth : 0,
      hostileNodes: root.querySelectorAll('script,style,img,iframe,svg,a[href],[onclick],[onmouseover]').length,
      pwned: !!window.pwned
    };
  })()`);
}

async function screenshot(win, name) {
  const image = await win.webContents.capturePage();
  const output = path.join(screenshots, name);
  fs.writeFileSync(output, image.toPNG());
  return path.relative(__dirname, output);
}

async function showRich(win, html, gen) {
  const ready = new Promise((resolve) => ipcMain.once('overlay:rich-ready', (_event, data) => resolve(data)));
  win.webContents.send('overlay:loading', { gen, voice: 'Hope — Clear', html, fontSize: 20, speed: 1 });
  const result = await ready;
  const characters = [...result.text];
  win.webContents.send('overlay:chunk', {
    audioBase64: null,
    alignment: {
      characters,
      character_start_times_seconds: characters.map((_, i) => i * 0.03),
      character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.03),
    },
  });
  win.webContents.send('overlay:all-done');
  await new Promise((resolve) => setTimeout(resolve, 100));
  return result;
}

async function run() {
  fs.mkdirSync(screenshots, { recursive: true });
  let externalRequests = 0;
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => { externalRequests++; callback({ cancel: true }); }
  );
  const win = new BrowserWindow({
    width: 740,
    height: 680,
    frame: false,
    transparent: true,
    show: true,
    webPreferences: {
      preload: path.join(root, 'src/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(root, 'src/overlay.html'));

  const clipboardPayload = readClipboardContent({
    readText: () => 'Here is the table. Options selected Users Share 1 160 17.7% 2 85 9.4% After the table.',
    readHTML: () => table,
  });
  const ready = await showRich(win, clipboardPayload.html, 1);
  const normal = await inspect(win);
  normal.canonical = ready.text;
  normal.screenshot = await screenshot(win, 'table-three-columns.png');

  await showRich(win, wide, 2);
  const wideResult = await inspect(win);
  wideResult.screenshot = await screenshot(win, 'table-wide-scroll.png');

  await showRich(win, hostile, 3);
  const hostileResult = await inspect(win);
  hostileResult.externalRequests = externalRequests;
  hostileResult.screenshot = await screenshot(win, 'table-sanitized.png');

  const plain = 'Plain clipboard text still reads.';
  win.webContents.send('overlay:loading', { gen: 4, voice: 'Hope — Clear', html: null, fontSize: 20, speed: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  win.webContents.send('overlay:chunk', {
    audioBase64: null,
    alignment: {
      characters: [...plain],
      character_start_times_seconds: [...plain].map((_, i) => i * 0.03),
      character_end_times_seconds: [...plain].map((_, i) => (i + 1) * 0.03),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const plainResult = await inspect(win);
  plainResult.screenshot = await screenshot(win, 'plain-text-regression.png');

  const checks = {
    tableRows: normal.tableCount === 1 && normal.rows.length === 3 && normal.rows.every((row) => row.length === 3),
    alignedColumns: normal.rows.every((row) => row.every((cell) => cell.y === row[0].y) && row[0].x < row[1].x && row[1].x < row[2].x),
    rowOrder: normal.rows[0][0].y < normal.rows[1][0].y && normal.rows[1][0].y < normal.rows[2][0].y,
    spokenOrder: ready.ok && ready.text === 'Here is the table. Options selected Users Share 1 160 17.7% 2 85 9.4% After the table.',
    wideScrollable: wideResult.scrollWidth > wideResult.clientWidth && wideResult.overflowX === 'auto',
    hostileSafe: hostileResult.hostileNodes === 0 && !hostileResult.pwned && !hostileResult.text.includes('window.pwned') && hostileResult.externalRequests === 0,
    plainUnchanged: plainResult.text === plain,
  };
  const result = { checks, normal, wide: wideResult, hostile: hostileResult, plain: plainResult };
  fs.writeFileSync(path.join(__dirname, 'table-qa-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ checks, screenshots: [normal.screenshot, wideResult.screenshot, hostileResult.screenshot, plainResult.screenshot] }));
  win.close();
  app.quit();
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
