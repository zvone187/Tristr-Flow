'use strict';

// Real Chromium selection copy, Electron clipboard reads, and the production overlay.
// This harness never imports app startup, registers hotkeys, or calls a voice provider.
const { app, BrowserWindow, clipboard, ipcMain, nativeImage, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readClipboardContent } = require('../../src/clipboard-content');

const root = path.resolve(__dirname, '../..');
const taskDir = path.join(__dirname, '../image-aspect-ratio');
const screenshotDir = path.join(taskDir, 'qa-screenshots');
const resultsPath = path.join(taskDir, 'image-qa-results.json');
const manifestPath = path.join(taskDir, 'qa-e2e-tests.json');
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tristr-image-qa-'));
app.setPath('userData', path.join(temporaryDir, 'electron-user-data'));

// A single Cocoa write restores every raw representation atomically. Repeated
// clipboard.writeBuffer calls would replace earlier representations on macOS.
const clipboardHelperSource = `
import AppKit
import Foundation

struct Item: Codable, Equatable { let formats: [String: String] }
struct Snapshot: Codable, Equatable { let changeCount: Int; let items: [Item] }
let pasteboard = NSPasteboard.general
func snapshot() throws -> Snapshot {
  var items: [Item] = []
  for item in pasteboard.pasteboardItems ?? [] {
    var formats: [String: String] = [:]
    for type in item.types {
      guard let data = item.data(forType: type) else {
        throw NSError(domain: "ClipboardQA", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Cannot preserve clipboard type " + type.rawValue])
      }
      formats[type.rawValue] = data.base64EncodedString()
    }
    items.append(Item(formats: formats))
  }
  return Snapshot(changeCount: pasteboard.changeCount, items: items)
}
func emit(_ value: [String: Any]) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}
do {
  if CommandLine.arguments[1] == "snapshot" {
    let data = try JSONEncoder().encode(snapshot())
    print(String(data: data, encoding: .utf8)!)
  } else {
    let decoder = JSONDecoder()
    let original = try decoder.decode(Snapshot.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
    let expected = try decoder.decode(Snapshot.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])))
    let current = try snapshot()
    if current != expected {
      try emit(["restored": false, "reason": "Clipboard changed outside the harness; newer clipboard contents preserved."])
    } else {
      let objects = try original.items.map { saved -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, encoded) in saved.formats {
          guard let data = Data(base64Encoded: encoded), item.setData(data, forType: NSPasteboard.PasteboardType(type)) else {
            throw NSError(domain: "ClipboardQA", code: 2,
              userInfo: [NSLocalizedDescriptionKey: "Cannot reconstruct clipboard type " + type])
          }
        }
        return item
      }
      pasteboard.clearContents()
      if !objects.isEmpty && !pasteboard.writeObjects(objects) {
        throw NSError(domain: "ClipboardQA", code: 3,
          userInfo: [NSLocalizedDescriptionKey: "Clipboard restore failed"])
      }
      let restored = try snapshot()
      try emit(["restored": restored.items == original.items,
        "itemCount": original.items.count,
        "formatCount": original.items.reduce(0) { $0 + $1.formats.count }])
      if restored.items != original.items { exit(1) }
    }
  }
} catch {
  fputs("Clipboard guard: " + error.localizedDescription + "\\n", stderr)
  exit(1)
}
`;

let clipboardHelper;
let originalClipboard;
let ownedClipboard;
let sourceWindow;
let overlayWindow;
let fixtureServer;
let origin;
let largePng;
let smallPng;
let landscapePng;
let portraitPng;
let originalSize;
let thumbnailSize;
const landscapeSize = { width: 600, height: 300 };
const portraitSize = { width: 200, height: 400 };
const requestLog = [];
const serverLog = [];
const evidence = { tests: {}, checks: {}, screenshots: [], providerRequests: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshotClipboard() {
  return JSON.parse(execFileSync(clipboardHelper, ['snapshot'], { encoding: 'utf8' }));
}

function sameClipboard(left, right) {
  if (left.changeCount !== right.changeCount || left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => {
    const other = right.items[index].formats;
    const keys = Object.keys(item.formats).sort();
    return JSON.stringify(keys) === JSON.stringify(Object.keys(other).sort()) &&
      keys.every((key) => item.formats[key] === other[key]);
  });
}

function prepareClipboardGuard() {
  if (process.platform !== 'darwin') throw new Error('This harness requires the macOS raw pasteboard restoration guard.');
  const swiftPath = path.join(temporaryDir, 'clipboard-guard.swift');
  clipboardHelper = path.join(temporaryDir, 'clipboard-guard');
  fs.writeFileSync(swiftPath, clipboardHelperSource);
  execFileSync('/usr/bin/swiftc', [swiftPath, '-o', clipboardHelper], { stdio: 'pipe' });
  originalClipboard = snapshotClipboard();
  evidence.clipboard = {
    originalItemCount: originalClipboard.items.length,
    originalFormatCount: originalClipboard.items.reduce((sum, item) => sum + Object.keys(item.formats).length, 0),
  };
}

function restoreClipboard() {
  if (!originalClipboard || !ownedClipboard) return;
  const originalPath = path.join(temporaryDir, 'clipboard-original.json');
  const ownedPath = path.join(temporaryDir, 'clipboard-owned.json');
  fs.writeFileSync(originalPath, JSON.stringify(originalClipboard), { mode: 0o600 });
  fs.writeFileSync(ownedPath, JSON.stringify(ownedClipboard), { mode: 0o600 });
  evidence.clipboard.restore = JSON.parse(execFileSync(clipboardHelper, ['restore', originalPath, ownedPath], { encoding: 'utf8' }));
}

function page(article) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local article selection fixture</title>
    <style>body{font:18px/1.45 system-ui;background:#fff;color:#222;margin:28px auto;max-width:760px}
    aside{padding:10px;border:1px solid #ccc;font-size:14px}aside img{width:50px;vertical-align:middle}
    article img{display:block;max-width:100%;height:auto}figure{margin:14px 0}figcaption{font-size:15px;color:#555}</style></head>
    <body><aside>Unselected surrounding content <img src="/unselected.png" alt="UNSELECTED ALT"></aside>
    <article id="selection">${article}</article><footer>Unselected footer text.</footer></body></html>`;
}

function firstArticle() {
  return page(`<h1>Selected article</h1><p>Before <strong>the picture</strong>.</p>
    <figure><img src="/article.png?case=selected" alt="ALT ARTICLE SHOULD NOT BE SPOKEN"
      id="copied-image"><figcaption>Caption follows the picture.</figcaption></figure>
    <p>After the picture, continue reading.</p>`);
}

function secondArticle() {
  return page(`<h1>Second reading.</h1><figure><picture><source srcset="/unused-source.png?case=source">
    <img src="/second.png?case=repeat" alt="ALT FALLBACK SHOULD NOT BE SPOKEN" srcset="/unused-srcset.png 2x"></picture>
    <figcaption>Picture fallback is shown now.</figcaption></figure><p>Embedded PNG is shown below.</p>
    <img src="data:image/png;base64,${smallPng.toString('base64')}" alt="ALT EMBEDDED SHOULD NOT BE SPOKEN">
    <p>End of second reading.</p>`);
}

function hostileArticle() {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.qaPwned=true"></svg>').toString('base64');
  return `<p>Safe introduction.</p><figure onclick="window.qaPwned=true" style="position:fixed">
    <img src="${origin}/safe.png?case=hostile" alt="ALT SAFE SHOULD NOT BE SPOKEN" id="unsafe-id" class="unsafe-class"
      width="9000" height="1" style="position:fixed;inset:0" srcset="${origin}/unsafe-srcset.png 2x"
      onload="window.qaPwned=true" onerror="window.qaPwned=true" referrerpolicy="unsafe-url" decoding="sync">
    <figcaption>Safe caption.</figcaption></figure>
    <img src="file:///etc/passwd" alt="ALT FILE"><img src="javascript:window.qaPwned=true" alt="ALT SCRIPT">
    <img src="blob:${origin}/unsafe-blob" alt="ALT BLOB"><img src="data:image/svg+xml;base64,${svg}" alt="ALT SVG">
    <img src="data:text/html;base64,PGgxPlVuc2FmZTwvaDE+" alt="ALT HTML"><img src="data:image/png;base64,not-base64" alt="ALT MALFORMED">
    <img src="/relative-local-file.png" alt="ALT RELATIVE"><img src="${origin.replace('http://', 'http://user:secret@')}/credentials.png" alt="ALT AUTH">
    <img src="${origin}/missing.png" alt="ALT BROKEN SHOULD NOT BE SPOKEN"><p>Broken image leaves this sentence intact.</p>
    <img src="//qa.invalid/protocol-relative.png" alt="ALT PROTOCOL"><img src="http://qa.invalid/allowed-http.png" alt="ALT HTTP">
    <img src="https://qa.invalid/allowed-https.png" alt="ALT HTTPS">
    <img src="data:image/png;base64,${smallPng.toString('base64')}" alt="ALT DATA">
    <script>window.qaPwned=true;fetch('${origin}/unsafe-script');</script>
    <iframe src="${origin}/unsafe-frame"></iframe><style>body{display:none}</style>
    <a href="${origin}/unsafe-navigation" target="_blank" onclick="window.qaPwned=true">Safe link text.</a>
    <table onclick="window.qaPwned=true"><thead><tr><th>Topic</th><th>Value</th></tr></thead>
    <tbody><tr><td>Images</td><td>Included</td></tr></tbody></table><p>Safe ending.</p>`;
}

function shapeArticle() {
  return page(`<h1>Original image shapes</h1>
    <figure><img src="/landscape.png?case=shapes" alt="ALT LANDSCAPE"><figcaption>Landscape stays wide.</figcaption></figure>
    <figure><img src="/portrait.png?case=shapes" alt="ALT PORTRAIT"><figcaption>Portrait stays tall.</figcaption></figure>
    <table><thead><tr><th>Shape</th><th>Image</th></tr></thead><tbody>
    <tr><td>Square</td><td><img src="/article.png?case=table" alt="ALT TABLE SQUARE"></td></tr>
    <tr><td>Landscape</td><td><img src="/landscape.png?case=table" alt="ALT TABLE LANDSCAPE"></td></tr>
    <tr><td>Portrait</td><td><img src="/portrait.png?case=table" alt="ALT TABLE PORTRAIT"></td></tr>
    </tbody></table><p>End of shapes.</p>`);
}

// Each rectangle is authored at its own native dimensions. Circular markings
// make stretching visible, without resizing or altering the original logo.
function rectanglePng(size) {
  const bitmap = Buffer.alloc(size.width * size.height * 4);
  const radius = Math.min(size.width, size.height) / 3;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const index = (y * size.width + x) * 4;
      const circle = (x - size.width / 2) ** 2 + (y - size.height / 2) ** 2 <= radius ** 2;
      const border = x < 4 || y < 4 || x >= size.width - 4 || y >= size.height - 4;
      const color = border ? [45, 45, 45] : circle ? [170, 115, 45] : [215, 230, 245];
      bitmap[index] = color[0]; bitmap[index + 1] = color[1]; bitmap[index + 2] = color[2]; bitmap[index + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, size).toPNG();
}

async function startFixture() {
  const logo = nativeImage.createFromPath(path.join(root, 'assets/logo.png'));
  if (logo.isEmpty()) throw new Error('Fixture logo image is missing or empty.');
  originalSize = logo.getSize();
  largePng = fs.readFileSync(path.join(root, 'assets/logo.png'));
  const thumbnail = logo.resize({ width: 100, quality: 'best' });
  thumbnailSize = thumbnail.getSize();
  smallPng = thumbnail.toPNG();
  landscapePng = rectanglePng(landscapeSize);
  portraitPng = rectanglePng(portraitSize);
  fixtureServer = http.createServer((request, response) => {
    const pathname = new URL(request.url, origin || 'http://127.0.0.1').pathname;
    serverLog.push({ path: request.url, referer: request.headers.referer || '', method: request.method });
    response.setHeader('Cache-Control', 'no-store');
    if (['/article', '/repeat', '/aspects'].includes(pathname)) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pathname === '/article' ? firstArticle() : pathname === '/repeat' ? secondArticle() : shapeArticle());
    } else if (pathname === '/article.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(largePng);
    } else if (['/second.png', '/landscape.png', '/unused-source.png', '/unused-srcset.png'].includes(pathname)) {
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(landscapePng);
    } else if (pathname === '/portrait.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(portraitPng);
    } else if (['/safe.png', '/unselected.png', '/unsafe-srcset.png'].includes(pathname)) {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(smallPng);
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Fixture resource is missing.');
    }
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + fixtureServer.address().port;
  // Verify the listener before opening the browser, using the actual chosen port.
  await new Promise((resolve, reject) => {
    http.get(origin + '/article', (response) => {
      response.resume();
      if (response.statusCode !== 200) reject(new Error('Fixture development server is not ready.'));
      else response.on('end', resolve);
    }).once('error', reject);
  });
  evidence.fixture = { origin, listenerVerified: true,
    originalAsset: { path: 'assets/logo.png', ...originalSize, servedWithoutTransformation: true },
    thumbnailSize, thumbnailResizedByWidthOnly: true, landscapeSize, portraitSize };
}

async function selectAndCopy(route) {
  await sourceWindow.loadURL(origin + route);
  if (sourceWindow.webContents.getURL() !== origin + route) throw new Error('Source browser URL does not match the fixture.');
  sourceWindow.show(); sourceWindow.focus(); sourceWindow.webContents.focus();
  await sleep(100);
  const before = snapshotClipboard();
  if (!sameClipboard(before, ownedClipboard || originalClipboard)) throw new Error('Clipboard changed outside the harness before Copy.');
  const selection = await sourceWindow.webContents.executeJavaScript(`(() => {
    const article = document.getElementById('selection');
    const range = document.createRange();
    range.selectNodeContents(article);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    return { text: selection.toString(), imageCount: range.cloneContents().querySelectorAll('img').length,
      images: [...article.querySelectorAll('img')].map(img => ({ src: img.src, currentSrc: img.currentSrc,
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height })),
      url: location.href, selectedArticle: article.contains(selection.anchorNode) && article.contains(selection.focusNode) };
  })()`);
  sourceWindow.webContents.copy();
  let copied;
  for (let attempts = 0; attempts < 20; attempts++) {
    await sleep(50);
    copied = snapshotClipboard();
    if (copied.changeCount !== before.changeCount) break;
  }
  if (copied.changeCount === before.changeCount) throw new Error('Real Chromium Copy left the clipboard unchanged.');
  ownedClipboard = copied;
  const captured = readClipboardContent(clipboard);
  if (!captured.html || !captured.text) throw new Error('Real Chromium Copy did not produce rich clipboard content.');
  return { ...captured, selection };
}

async function screenshot(window, filename) {
  const output = path.join(screenshotDir, filename);
  let capture;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { capture = await window.webContents.capturePage(); break; }
    catch (error) {
      if (attempt === 2) throw new Error('Screenshot failed for ' + filename + ': ' + error.message);
      await sleep(150);
    }
  }
  fs.writeFileSync(output, capture.toPNG());
  const relative = path.relative(taskDir, output);
  evidence.screenshots.push(relative);
  return relative;
}

async function renderRich(html, gen) {
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ipcMain.removeListener('overlay:rich-ready', listener); reject(new Error('Production rich-ready IPC timed out.')); }, 5000);
    const listener = (event, payload) => {
      if (event.sender !== overlayWindow.webContents || payload.gen !== gen) return;
      clearTimeout(timer); ipcMain.removeListener('overlay:rich-ready', listener); resolve(payload);
    };
    ipcMain.on('overlay:rich-ready', listener);
  });
  overlayWindow.webContents.send('overlay:loading', { gen, voice: 'Local QA Voice', html, fontSize: 20, speed: 1 });
  const result = await ready;
  if (!result.ok || !result.text) throw new Error('Production overlay rejected the rich fixture.');
  await sendAlignment(result.text);
  await waitForImages();
  return result;
}

async function sendAlignment(text) {
  const characters = [...text];
  overlayWindow.webContents.send('overlay:chunk', {
    audioBase64: null,
    alignment: { characters, character_start_times_seconds: characters.map((_, i) => i * 0.03),
      character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.03) },
  });
  overlayWindow.webContents.send('overlay:all-done');
  await sleep(100);
}

async function waitForImages() {
  await overlayWindow.webContents.executeJavaScript(`Promise.all([...document.querySelectorAll('#text img')].map(img => {
    if (img.complete) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Image did not settle: ' + img.src)), 5000);
      const settled = () => { clearTimeout(timer); resolve(); };
      img.addEventListener('load', settled, { once: true }); img.addEventListener('error', settled, { once: true });
    });
  })).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
}

async function inspect(expectedText) {
  return overlayWindow.webContents.executeJavaScript(`(() => {
    const expected = ${JSON.stringify(expectedText)};
    const root = document.getElementById('text');
    const wrap = document.getElementById('textwrap');
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const allWords = words.map(w => ({ text: w.el.textContent, first: w.first, last: w.last,
      connected: root.contains(w.el), generated: w.el.classList.contains('gen') }));
    const exactWordMap = allWords.every((w, index) => expected.slice(w.first, w.last + 1) === w.text &&
      Array.from({ length: w.last - w.first + 1 }, (_, offset) => charToWord[w.first + offset]).every(value => value === index));
    const exactSpaceMap = [...expected].every((ch, index) => !/\\s/.test(ch) || charToWord[index] === -1);
    const images = [...root.querySelectorAll('img')].map(img => ({
      src: img.getAttribute('src'), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      complete: img.complete, hidden: img.hidden, display: getComputedStyle(img).display,
      inTable: !!img.closest('table'),
      bounds: rect(img), attrs: Object.fromEntries([...img.attributes].map(a => [a.name, a.value])),
      referrerPolicy: img.referrerPolicy, decoding: img.decoding,
    }));
    const caption = root.querySelector('figcaption');
    const image = root.querySelector('img');
    return {
      text: root.textContent, wordText: allWords.map(w => w.text).join(' '), words: allWords,
      charMapLength: charToWord.length, alignmentLength: charStart.length, exactWordMap, exactSpaceMap,
      allGenerated: allWords.every(w => w.generated && w.connected), images,
      rootBounds: rect(root), wrapBounds: rect(wrap), wrapClientWidth: wrap.clientWidth, wrapScrollWidth: wrap.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth, pageScrollWidth: document.documentElement.scrollWidth,
      captionAfterImage: !!(image && caption && (image.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING)),
      tableCount: root.querySelectorAll('table').length,
      tableRows: [...root.querySelectorAll('tr')].map(row => [...row.children].map(cell => ({ tag: cell.tagName, text: cell.textContent, bounds: rect(cell) }))),
      unsafeNodeCount: root.querySelectorAll('script,style,iframe,svg,source,a[href],[srcset],[style],[id],[onclick],[onload],[onerror]').length,
      pwned: !!window.qaPwned, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      cspViolations: window.qaCspViolations || [],
      nodeIntegrationExposed: typeof require !== 'undefined' || typeof process !== 'undefined',
    };
  })()`);
}

function exactMapping(result, expected) {
  return result.wordText === expected && result.exactWordMap && result.exactSpaceMap &&
    result.charMapLength === expected.length && result.alignmentLength === expected.length && result.allGenerated;
}

function fitImages(result) {
  return result.images.filter(image => !image.hidden).every(image => image.naturalWidth > 0 && image.bounds.width > 0 &&
    image.bounds.x >= result.rootBounds.x - 1 && image.bounds.right <= result.rootBounds.right + 1 &&
    Math.abs(image.bounds.width / image.bounds.height - image.naturalWidth / image.naturalHeight) < 0.015) &&
    result.wrapScrollWidth <= result.wrapClientWidth + 1 && result.pageScrollWidth <= result.pageClientWidth + 1;
}

function imageAttributesSafe(result) {
  const allowed = new Set(['src', 'alt', 'referrerpolicy', 'decoding', 'hidden']);
  return result.images.every(image => Object.keys(image.attrs).every(key => allowed.has(key)) &&
    image.referrerPolicy === 'no-referrer' && image.decoding === 'async');
}

function originalRatiosMatch(source, overlay, sizes) {
  if (source.images.length !== sizes.length || overlay.images.length !== sizes.length) return false;
  return sizes.every((size, index) => {
    const ratio = size.width / size.height;
    const sourceImage = source.images[index];
    const overlayImage = overlay.images[index];
    return sourceImage.naturalWidth / sourceImage.naturalHeight === ratio &&
      Math.abs(sourceImage.height - sourceImage.width / ratio) <= 1 &&
      overlayImage.naturalWidth === size.width && overlayImage.naturalHeight === size.height &&
      overlayImage.bounds.width > 0 && overlayImage.bounds.height > 0 && !overlayImage.hidden &&
      Math.abs(overlayImage.bounds.height - overlayImage.bounds.width / ratio) <= 1;
  });
}

async function screenshotAt(selector, filename) {
  await overlayWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' })`);
  await sleep(80);
  return screenshot(overlayWindow, filename);
}

async function runCases() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const partition = session.fromPartition('image-qa-' + Date.now());
  partition.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const allowed = new URL(details.url).origin === origin;
    requestLog.push({ url: details.url, webContentsId: details.webContentsId, resourceType: details.resourceType, allowed });
    callback({ cancel: !allowed });
  });
  sourceWindow = new BrowserWindow({ width: 900, height: 800, show: true,
    webPreferences: { session: partition, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  overlayWindow = new BrowserWindow({ width: 740, height: 680, frame: false, transparent: true, show: true,
    resizable: false, hasShadow: false, webPreferences: { session: partition,
      preload: path.join(root, 'src/preload.js'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false } });
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWindow.webContents.on('will-navigate', event => event.preventDefault());
  evidence.productionPreferences = overlayWindow.webContents.getLastWebPreferences();
  await overlayWindow.loadFile(path.join(root, 'src/overlay.html'));
  await overlayWindow.webContents.insertCSS('* { animation: none !important; transition: none !important; scroll-behavior: auto !important; }');
  await overlayWindow.webContents.executeJavaScript(`window.qaCspViolations = []; document.addEventListener('securitypolicyviolation', e =>
    window.qaCspViolations.push({ directive: e.violatedDirective, blockedURI: e.blockedURI }));`);

  const firstCopy = await selectAndCopy('/article');
  const sourceScreenshot = await screenshot(sourceWindow, 'source-selected-article.png');
  const firstExpected = 'Selected article Before the picture. Caption follows the picture. After the picture, continue reading.';
  const firstReady = await renderRich(firstCopy.html, 1);
  const first = await inspect(firstExpected);
  first.screenshot = await screenshot(overlayWindow, 'article-image-normal.png');
  const selectedAbsolute = origin + '/article.png?case=selected';
  evidence.tests['article-image'] = { clipboardHTML: firstCopy.html, clipboardText: firstCopy.text, selection: firstCopy.selection,
    sourceScreenshot, canonical: firstReady.text, renderer: first, checks: {
      actualRichCopy: firstCopy.selection.selectedArticle && firstCopy.selection.imageCount === 1,
      relativeURLResolvedByChromium: firstCopy.html.includes(selectedAbsolute),
      selectedImageDecoded: first.images.length === 1 && first.images[0].src === selectedAbsolute && first.images[0].naturalWidth === originalSize.width,
      unrelatedContentAbsent: !firstCopy.html.includes('unselected.png') && !first.wordText.includes('Unselected') && !first.images.some(image => image.src.includes('unselected')),
      captionInDocumentOrder: first.captionAfterImage,
      exactCanonicalAndWordMapping: firstReady.text === firstExpected && exactMapping(first, firstExpected),
      imageFitsNormalWindow: fitImages(first), safeImageAttributes: imageAttributesSafe(first),
      sourceAndOverlayMatchUntouchedOriginalAspect: originalRatiosMatch(firstCopy.selection, first, [originalSize]),
    } };

  overlayWindow.setResizable(true); overlayWindow.setSize(430, 680); overlayWindow.setResizable(false);
  await sleep(120);
  const narrow = await inspect(firstExpected);
  narrow.screenshot = await screenshot(overlayWindow, 'article-image-narrow.png');
  const secondCopy = await selectAndCopy('/repeat');
  const secondExpected = 'Second reading. Picture fallback is shown now. Embedded PNG is shown below. End of second reading.';
  const secondReady = await renderRich(secondCopy.html, 2);
  const repeat = await inspect(secondExpected);
  repeat.screenshot = await screenshot(overlayWindow, 'article-image-repeat.png');
  evidence.tests['resize-repeat'] = { clipboardHTML: secondCopy.html, canonical: secondReady.text, selection: secondCopy.selection,
    narrow, repeat, checks: {
      imageFitsNarrowWindow: fitImages(narrow),
      repeatHasOnlyNewImages: repeat.images.length === 2 && repeat.images[0].src === origin + '/second.png?case=repeat' &&
        repeat.images[1].src.startsWith('data:image/png;base64,') && !repeat.images.some(image => image.src === selectedAbsolute),
      fallbackAndEmbeddedImagesDecoded: repeat.images.every(image => image.naturalWidth > 0 && !image.hidden),
      repeatedImagesFitNarrowWindow: fitImages(repeat),
      exactCanonicalAndWordMapping: secondReady.text === secondExpected && exactMapping(repeat, secondExpected),
      copiedSourceAndSrcsetExcluded: repeat.unsafeNodeCount === 0 && imageAttributesSafe(repeat),
      untouchedOriginalAspectAtNarrowWidth: originalRatiosMatch(firstCopy.selection, narrow, [originalSize]),
      repeatedSourceAndOverlayMatchOriginalAspects: originalRatiosMatch(secondCopy.selection, repeat, [landscapeSize, thumbnailSize]),
    } };

  overlayWindow.setResizable(true); overlayWindow.setSize(740, 680); overlayWindow.setResizable(false);
  const shapeCopy = await selectAndCopy('/aspects');
  const shapeExpected = 'Original image shapes Landscape stays wide. Portrait stays tall. Shape Image Square Landscape Portrait End of shapes.';
  const shapeReady = await renderRich(shapeCopy.html, 3);
  const shapesNormal = await inspect(shapeExpected);
  shapesNormal.screenshots = [await screenshotAt('#text figure', 'aspect-landscape-normal.png'),
    await screenshotAt('#text figure:nth-of-type(2)', 'aspect-portrait-normal.png'),
    await screenshotAt('#text table', 'aspect-table-normal.png')];
  overlayWindow.setResizable(true); overlayWindow.setSize(430, 680); overlayWindow.setResizable(false);
  await sleep(120);
  const shapesNarrow = await inspect(shapeExpected);
  shapesNarrow.screenshots = [await screenshotAt('#text figure', 'aspect-landscape-narrow.png'),
    await screenshotAt('#text figure:nth-of-type(2)', 'aspect-portrait-narrow.png'),
    await screenshotAt('#text table', 'aspect-table-narrow.png')];
  const shapeSizes = [landscapeSize, portraitSize, originalSize, landscapeSize, portraitSize];
  evidence.tests['resize-repeat'].aspectFixtures = { selection: shapeCopy.selection, canonical: shapeReady.text,
    normal: shapesNormal, narrow: shapesNarrow, originalImageSizes: shapeSizes };
  Object.assign(evidence.tests['resize-repeat'].checks, {
      actualShapeArticleCopy: shapeCopy.selection.selectedArticle && shapeCopy.selection.imageCount === 5,
      sourceAndNormalOverlayMatchOriginalAspects: originalRatiosMatch(shapeCopy.selection, shapesNormal, shapeSizes),
      sourceAndNarrowOverlayMatchOriginalAspects: originalRatiosMatch(shapeCopy.selection, shapesNarrow, shapeSizes),
      tableImagesRetainOriginalAspects: shapesNormal.images.filter(image => image.inTable).length === 3 &&
        shapesNarrow.images.filter(image => image.inTable).length === 3 &&
        originalRatiosMatch(shapeCopy.selection, shapesNormal, shapeSizes) && originalRatiosMatch(shapeCopy.selection, shapesNarrow, shapeSizes),
      tableWrapperContainsPageOverflow: shapesNormal.wrapScrollWidth <= shapesNormal.wrapClientWidth + 1 &&
        shapesNarrow.wrapScrollWidth <= shapesNarrow.wrapClientWidth + 1 && shapesNarrow.pageScrollWidth <= shapesNarrow.pageClientWidth + 1,
      shapeCanonicalAndWordMapping: shapeReady.text === shapeExpected && exactMapping(shapesNormal, shapeExpected) && exactMapping(shapesNarrow, shapeExpected),
      safeCopiedAttributesAndSourceURLs: shapesNormal.unsafeNodeCount === 0 && shapesNarrow.unsafeNodeCount === 0 && imageAttributesSafe(shapesNormal),
    });

  overlayWindow.setResizable(true); overlayWindow.setSize(740, 680); overlayWindow.setResizable(false);
  const hostileExpected = 'Safe introduction. Safe caption. Broken image leaves this sentence intact. Safe link text. Topic Value Images Included Safe ending.';
  const hostileReady = await renderRich(hostileArticle(), 4);
  const hostile = await inspect(hostileExpected);
  hostile.screenshot = await screenshot(overlayWindow, 'article-image-hostile.png');
  const plainExpected = 'Plain clipboard text still reads correctly.';
  overlayWindow.webContents.send('overlay:loading', { gen: 5, voice: 'Local QA Voice', html: null, fontSize: 20, speed: 1 });
  await sleep(80); await sendAlignment(plainExpected);
  const plain = await inspect(plainExpected);
  plain.screenshot = await screenshot(overlayWindow, 'article-image-plain.png');
  const overlayRequests = requestLog.filter(request => request.webContentsId === overlayWindow.webContents.id);
  const allowedPaths = new Set(['/article.png', '/second.png', '/landscape.png', '/portrait.png', '/safe.png', '/missing.png']);
  const allowedExternal = new Set(['https://qa.invalid/protocol-relative.png', 'http://qa.invalid/allowed-http.png', 'https://qa.invalid/allowed-https.png']);
  const unsanitizedRequests = overlayRequests.filter(request => new URL(request.url).origin === origin ?
    !allowedPaths.has(new URL(request.url).pathname) : !allowedExternal.has(request.url));
  const broken = hostile.images.find(image => image.src === origin + '/missing.png');
  const visibleHostile = hostile.images.filter(image => !image.hidden);
  evidence.tests['safety-regression'] = { canonical: hostileReady.text, hostile, plain, overlayRequests, unsanitizedRequests, checks: {
    onlyAllowedImageSources: hostile.images.length === 6 && hostile.images.every(image =>
      image.src === origin + '/safe.png?case=hostile' || image.src === origin + '/missing.png' ||
      allowedExternal.has(image.src) || image.src.startsWith('data:image/png;base64,')),
    HTTPAndHTTPSAllowedAndProtocolRelativeIsHTTPS: allowedExternal.size === 3 && [...allowedExternal].every(src => hostile.images.some(image => image.src === src)),
    handlersScriptsAndCopiedAttributesRemoved: hostile.unsafeNodeCount === 0 && !hostile.pwned && imageAttributesSafe(hostile),
    noUntrustedResourceRequests: unsanitizedRequests.length === 0,
    imagesOmitReferrers: serverLog.filter(request => /case=(?:selected|repeat|hostile)/.test(request.path) && request.referer.startsWith('file:')).length === 0 &&
      overlayRequests.filter(request => new URL(request.url).origin === origin).length >= 4 &&
      serverLog.filter(request => request.path.includes('/safe.png?case=hostile') || request.path === '/missing.png').every(request => request.referer === ''),
    brokenImageHiddenAndTextIntact: !!broken && broken.hidden && broken.naturalWidth === 0 && hostile.wordText.includes('Broken image leaves this sentence intact.'),
    localAndEmbeddedImagesStillVisible: visibleHostile.length === 2 && visibleHostile.every(image => image.naturalWidth > 0),
    hostileDimensionsCannotStretchOriginalImages: visibleHostile.length === 2 && visibleHostile.every(image =>
      image.naturalWidth === thumbnailSize.width && image.naturalHeight === thumbnailSize.height &&
      Math.abs(image.bounds.height - image.bounds.width * thumbnailSize.height / thumbnailSize.width) <= 1),
    tableRetainsRowsAndColumns: hostile.tableCount === 1 && hostile.tableRows.length === 2 && hostile.tableRows.every(row => row.length === 2) &&
      hostile.tableRows.every(row => row[0].bounds.x < row[1].bounds.x && row[0].bounds.y === row[1].bounds.y),
    exactCanonicalAndWordMapping: hostileReady.text === hostileExpected && exactMapping(hostile, hostileExpected),
    plainTextClearsImagesAndRetainsWordMap: plain.images.length === 0 && plain.tableCount === 0 && plain.text === plainExpected && exactMapping(plain, plainExpected),
    productionIsolationAndCSP: !hostile.nodeIntegrationExposed && /default-src 'none'/.test(hostile.csp) && /script-src 'self'/.test(hostile.csp) &&
      evidence.productionPreferences.contextIsolation && evidence.productionPreferences.sandbox && !evidence.productionPreferences.nodeIntegration,
  } };
  for (const test of manifest.tests) {
    const result = evidence.tests[test.id];
    if (!result) throw new Error('Manifest test has no harness implementation: ' + test.id);
    result.status = Object.values(result.checks).every(Boolean) ? 'passed' : 'failed';
    evidence.checks[test.id] = result.status === 'passed';
  }
  evidence.requests = requestLog;
  evidence.serverRequests = serverLog;
}

async function run() {
  let failed = false;
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    prepareClipboardGuard();
    await startFixture();
    await runCases();
    failed = Object.values(evidence.checks).some(passed => !passed);
  } catch (error) {
    evidence.error = error.stack || String(error);
    failed = true;
  } finally {
    try { restoreClipboard(); } catch (error) { evidence.clipboardRestoreError = String(error); failed = true; }
    for (const window of [sourceWindow, overlayWindow]) if (window && !window.isDestroyed()) window.destroy();
    if (fixtureServer) await new Promise(resolve => fixtureServer.close(resolve));
    fs.writeFileSync(resultsPath, JSON.stringify(evidence, null, 2));
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    console.log(JSON.stringify({ checks: evidence.checks, error: evidence.error || null,
      clipboard: evidence.clipboard, screenshots: evidence.screenshots, results: resultsPath }));
    app.exit(failed ? 1 : 0);
  }
}

function fixtureBaseline() {
  const logo = nativeImage.createFromPath(path.join(root, 'assets/logo.png'));
  const original = logo.getSize();
  const wide = logo.resize({ width: 1400, height: 600, quality: 'best' }).getSize();
  const small = logo.resize({ width: 100, height: 44, quality: 'best' }).getSize();
  const ratio = size => size.width / size.height;
  const result = { original, previousWideFixture: wide, previousSmallFixture: small,
    checks: { wideFixtureMatchesOriginalAspect: ratio(wide) === ratio(original),
      smallFixtureMatchesOriginalAspect: ratio(small) === ratio(original) } };
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'image-fixture-baseline.json'), JSON.stringify(result, null, 2));
  fs.rmSync(temporaryDir, { recursive: true, force: true });
  console.log(JSON.stringify(result));
  app.exit(Object.values(result.checks).every(Boolean) ? 0 : 1);
}

app.whenReady().then(() => process.argv.includes('--fixture-baseline') ? fixtureBaseline() : run())
  .catch(error => { console.error(error); app.exit(1); });
