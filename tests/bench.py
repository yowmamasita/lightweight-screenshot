import base64
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CAPTURE_JS = (ROOT / "capture.js").read_text()
STITCH_JS = (ROOT / "stitch.js").read_text()


def make_heavy_dom_html(sections=8, items_per_section=80):
    parts = ["""<!doctype html><html><head><style>
      html { scroll-behavior: smooth; }
      body { margin: 0; font-family: system-ui, sans-serif; background: #fff; }
      .nav { position: fixed; top: 0; left: 0; right: 0; height: 56px; background: #1e293b; color: #fff; z-index: 20; }
      .fab { position: fixed; bottom: 20px; right: 20px; width: 48px; height: 48px; border-radius: 50%; background: #2563eb; }
      .sec { padding: 64px 24px 24px; border-bottom: 1px solid #e2e8f0; }
      .sticky { position: sticky; top: 0; background: #f8fafc; padding: 8px; font-weight: 700; }
      .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      .card { padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; }
      svg.big { width: 24px; height: 24px; }
    </style></head><body>
    <header class="nav">Header</header>
    <div class="fab"></div>"""]
    for s in range(sections):
        parts.append(f'<section class="sec"><div class="sticky">Section {s}</div><div class="grid">')
        for i in range(items_per_section):
            parts.append(
                f'<div class="card"><span>Item {s}-{i}</span>'
                f'<svg class="big" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/><path d="M1 1L9 9"/></svg>'
                f'</div>'
            )
        parts.append('</div></section>')
    parts.append('</body></html>')
    return "".join(parts)


def bench_workload(browser, label, sections, items_per_section, single_frame=False):
    html = make_heavy_dom_html(sections=sections, items_per_section=items_per_section)
    page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=2)
    try:
        page.set_content(html)
        dom_count = page.evaluate("document.querySelectorAll('*').length")

        if single_frame:
            png_bytes = page.screenshot(type="png")
            data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
            res = page.evaluate("""async ({ dataUrl }) => {
              // Current path: decode -> bitmap -> canvas -> blob
              const t0 = performance.now();
              const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              const blob = new Blob([bytes], { type: 'image/png' });
              const bmp = await createImageBitmap(blob);
              const canvas = document.createElement('canvas');
              canvas.width = bmp.width;
              canvas.height = bmp.height;
              canvas.getContext('2d', { alpha: false }).drawImage(bmp, 0, 0);
              bmp.close();
              const canvasPathMs = performance.now() - t0;

              // Direct <img> path: blob -> URL.createObjectURL -> img.decode()
              const t1 = performance.now();
              const b64_2 = dataUrl.slice(dataUrl.indexOf(',') + 1);
              const bin_2 = atob(b64_2);
              const bytes_2 = new Uint8Array(bin_2.length);
              for (let i = 0; i < bin_2.length; i++) bytes_2[i] = bin_2.charCodeAt(i);
              const blob2 = new Blob([bytes_2], { type: 'image/png' });
              const url = URL.createObjectURL(blob2);
              const img = new Image();
              img.src = url;
              await img.decode();
              URL.revokeObjectURL(url);
              const imgPathMs = performance.now() - t1;

              return {
                size: `${img.naturalWidth}x${img.naturalHeight}`,
                canvasPathMs: Math.round(canvasPathMs * 10) / 10,
                imgPathMs: Math.round(imgPathMs * 10) / 10,
              };
            }""", {"dataUrl": data_url})
            print(f"[{label}] DOM={dom_count} | {res}")
            return

        page.add_script_tag(content=CAPTURE_JS)
        t0 = time.perf_counter()
        meta = page.evaluate("() => window.__lwScreenshot.init()")
        init_ms = (time.perf_counter() - t0) * 1000

        positions = page.evaluate("""async ({ meta, stitchSrc }) => {
          const modUrl = URL.createObjectURL(new Blob([stitchSrc], { type: 'text/javascript' }));
          const { computeScrollPositions } = await import(modUrl);
          URL.revokeObjectURL(modUrl);
          return computeScrollPositions(meta);
        }""", {"meta": meta, "stitchSrc": STITCH_JS})

        scroll_times = []
        tiles = []
        for step in positions:
            ts = time.perf_counter()
            actual = page.evaluate("(s) => window.__lwScreenshot.scrollToStep(s)", step)
            scroll_times.append((time.perf_counter() - ts) * 1000)
            png_bytes = page.screenshot(type="png")
            tiles.append({
                "row": step["row"],
                "col": step["col"],
                "actualX": actual["actualX"],
                "actualY": actual["actualY"],
                "dataUrl": "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii"),
            })
        page.evaluate("() => window.__lwScreenshot.cleanup()")

        res = page.evaluate("""async ({ tiles, meta, stitchSrc }) => {
          const modUrl = URL.createObjectURL(new Blob([stitchSrc], { type: 'text/javascript' }));
          const { computeTileDrawOps, planCanvasChunks, clipDrawOpToChunk } = await import(modUrl);
          URL.revokeObjectURL(modUrl);

          const heapBefore = performance.memory ? performance.memory.usedJSHeapSize : null;

          // Benchmark batch-all vs incremental draw+close + sequential encode+img-swap
          function toBlob(dataUrl) {
            const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type: 'image/png' });
          }

          // Current viewer approach: decode all -> draw all -> Promise.all toBlob
          const tA0 = performance.now();
          const bmps = await Promise.all(tiles.map((t) => createImageBitmap(toBlob(t.dataUrl))));
          const tilesMeta = tiles.map((t, i) => ({
            row: t.row, col: t.col, actualX: t.actualX, actualY: t.actualY,
            imgWidth: bmps[i].width, imgHeight: bmps[i].height,
          }));
          const { outWidth, outHeight, ops } = computeTileDrawOps(tilesMeta, meta);
          const chunks = planCanvasChunks(outWidth, outHeight);

          const canvases = [];
          for (const chunk of chunks) {
            const c = document.createElement('canvas');
            c.width = chunk.width;
            c.height = chunk.height;
            const ctx = c.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, chunk.width, chunk.height);
            for (const op of ops) {
              const cl = clipDrawOpToChunk(op, chunk);
              if (cl) ctx.drawImage(bmps[cl.tileIndex], cl.sx, cl.sy, cl.sw, cl.sh, cl.dx, cl.dy, cl.dw, cl.dh);
            }
            canvases.push(c);
          }
          bmps.forEach((b) => b.close());
          const allDrawMs = performance.now() - tA0;

          const tE0 = performance.now();
          const blobsAll = await Promise.all(canvases.map((c) => new Promise((r) => c.toBlob(r, 'image/png'))));
          const allEncodeMs = performance.now() - tE0;
          for (const c of canvases) { c.width = 0; c.height = 0; }

          // Optimized incremental approach: decode batches of 4 -> draw -> close -> sequential encode + canvas release
          const tB0 = performance.now();
          const batchSize = 4;
          const seqCanvases = chunks.map((chunk) => {
            const c = document.createElement('canvas');
            c.width = chunk.width;
            c.height = chunk.height;
            const ctx = c.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, chunk.width, chunk.height);
            return { chunk, c, ctx };
          });
          // Build ops grouped by tileIndex (without holding all bitmaps)
          const opsByTile = new Map();
          for (const op of ops) {
            if (!opsByTile.has(op.tileIndex)) opsByTile.set(op.tileIndex, []);
            opsByTile.get(op.tileIndex).push(op);
          }
          for (let start = 0; start < tiles.length; start += batchSize) {
            const end = Math.min(tiles.length, start + batchSize);
            const batchBmps = await Promise.all(
              tiles.slice(start, end).map((t) => createImageBitmap(toBlob(t.dataUrl)))
            );
            for (let j = 0; j < batchBmps.length; j++) {
              const bmp = batchBmps[j];
              const tileOps = opsByTile.get(start + j) || [];
              for (const op of tileOps) {
                for (const sc of seqCanvases) {
                  const cl = clipDrawOpToChunk(op, sc.chunk);
                  if (cl) sc.ctx.drawImage(bmp, cl.sx, cl.sy, cl.sw, cl.sh, cl.dx, cl.dy, cl.dw, cl.dh);
                }
              }
              bmp.close();
            }
          }
          const seqDrawMs = performance.now() - tB0;

          const tSE0 = performance.now();
          const blobsSeq = [];
          for (const sc of seqCanvases) {
            const blob = await new Promise((r) => sc.c.toBlob(r, 'image/png'));
            sc.c.width = 0;
            sc.c.height = 0;
            blobsSeq.push(blob);
          }
          const seqEncodeMs = performance.now() - tSE0;

          const heapAfter = performance.memory ? performance.memory.usedJSHeapSize : null;

          return {
            outSize: `${outWidth}x${outHeight}`,
            chunks: chunks.length,
            kb: Math.round(blobsAll.reduce((s, b) => s + b.size, 0) / 1024),
            allDrawMs: Math.round(allDrawMs * 10) / 10,
            allEncodeMs: Math.round(allEncodeMs * 10) / 10,
            seqDrawMs: Math.round(seqDrawMs * 10) / 10,
            seqEncodeMs: Math.round(seqEncodeMs * 10) / 10,
            heapDeltaMB: heapBefore != null ? Math.round((heapAfter - heapBefore) / (1024 * 1024) * 10) / 10 : null,
          };
        }""", {"tiles": tiles, "meta": meta, "stitchSrc": STITCH_JS})

        print(
            f"[{label}] DOM={dom_count} | init={init_ms:.1f}ms | "
            f"scrollAvg={sum(scroll_times)/len(scroll_times):.1f}ms ({len(positions)} tiles) | {res}"
        )
    finally:
        page.close()


def run_bench():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel="chrome")
        try:
            bench_workload(browser, "1-tile visible", sections=1, items_per_section=20, single_frame=True)
            bench_workload(browser, "12-tile medium", sections=8, items_per_section=80)
            bench_workload(browser, "38-tile heavy", sections=25, items_per_section=80)
        finally:
            browser.close()


if __name__ == "__main__":
    run_bench()
