# Lightweight Screenshot

Lightweight Manifest V3 extension for Chrome and Firefox for full-page and visible-area screenshots. ~56 KB total, zero dependencies, no build step, only `activeTab` and `scripting` permissions.

## Modes
- **Full Page** (`1`): scrolls and stitches the entire page or nested scroll container.
- **What You See** (`2` or `Alt+Shift+V` / `Option+Shift+V`): captures the visible viewport directly without touching the DOM or re-encoding the PNG.

## Install
- **Chrome** (121+): open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select this folder.
- **Firefox** (140+): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and select `manifest.json`.

One package serves both stores:
```bash
zip -r lightweight-screenshot.zip manifest.json *.js *.html *.css icons
```

## Privacy
Lightweight Screenshot collects no data. Screenshots are processed locally in your browser and never leave your device; the extension makes no network requests.

## Shortcuts
- `Alt+Shift+P` (`Option+Shift+P` on Mac): open mode menu (or click the icon again during capture to cancel).
- `Alt+Shift+V` (`Option+Shift+V` on Mac): capture visible viewport directly.
- Viewer tab: `Ctrl/Cmd+S` download PNG, `Ctrl/Cmd+C` copy to clipboard, `Z` or click image to toggle `Fit` / `100%`.

## How it works
- Respects Chrome's `2 calls / 1020 ms` `captureVisibleTab` quota across windows via a sliding-window limiter.
- Hides top/sticky headers after row 0 and preserves bottom-fixed footers on the final frame.
- Handles HiDPI/fractional zoom without 1 px seams, RTL horizontal scrolling, horizontal-only/bordered scroll containers, and oversized pages (>16,384 px) via 2D canvas chunks.
- Streams tiles in batches of 4, closes bitmaps immediately, encodes chunks sequentially, and swaps canvases for `<img>` elements to minimize memory.

## Tests & Benchmark
```bash
node --test tests/stitch.test.mjs
python3 tests/e2e.py
python3 tests/bench.py
```

## License
MIT
