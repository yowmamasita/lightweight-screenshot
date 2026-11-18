import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CAPTURE_JS = (ROOT / "capture.js").read_text()
STITCH_JS = (ROOT / "stitch.js").read_text()


def run_e2e():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel="chrome")
        try:
            # 1. Test standard window scroll + fixed/sticky elements + real screenshot stitching
            page = browser.new_page(viewport={"width": 800, "height": 600}, device_scale_factor=2)
            page.set_content("""
            <!doctype html>
            <html>
            <head>
              <style>
                html { scroll-behavior: smooth; }
                body { margin: 0; background: #ffffff; font-family: sans-serif; }
                .top-nav { position: fixed; top: 0; left: 0; right: 0; height: 50px; background: rgb(255, 0, 0); z-index: 10; }
                .fab { position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px; background: rgb(0, 0, 255); z-index: 10; }
                .sec { height: 700px; }
                .s1 { background: rgb(240, 240, 240); }
                .s2 { background: rgb(200, 230, 200); }
                .s3 { background: rgb(230, 200, 230); }
                .sticky-hdr { position: sticky; top: 0; height: 40px; background: rgb(255, 165, 0); }
              </style>
            </head>
            <body>
              <div class="top-nav" id="topNav">Top Nav</div>
              <div class="fab" id="fab">FAB</div>
              <section class="sec s1"></section>
              <section class="sec s2"><div class="sticky-hdr" id="stickyHdr">Sticky</div></section>
              <section class="sec s3"></section>
            </body>
            </html>
            """)

            # Pre-scroll so we verify cleanup() restores user's scroll position
            page.evaluate("window.scrollTo({ top: 350, behavior: 'instant' })")
            assert page.evaluate("window.scrollY") == 350

            page.add_script_tag(content=CAPTURE_JS)
            meta = page.evaluate("() => window.__gfpLite.init()")
            assert meta["mode"] == "window", f"Expected window mode, got {meta['mode']}"
            assert meta["viewportWidth"] == 800
            assert meta["viewportHeight"] == 600
            assert meta["contentHeight"] == 2100

            # Compute scroll positions using stitch.js via Node-compatible module eval in browser
            positions = page.evaluate("""async ({ meta, stitchSrc }) => {
              const modUrl = URL.createObjectURL(new Blob([stitchSrc], { type: 'text/javascript' }));
              const { computeScrollPositions } = await import(modUrl);
              URL.revokeObjectURL(modUrl);
              return computeScrollPositions(meta);
            }""", {"meta": meta, "stitchSrc": STITCH_JS})

            assert len(positions) == 4  # y = 0, 600, 1200, 1500

            tiles = []
            for idx, step in enumerate(positions):
                actual = page.evaluate("(s) => window.__gfpLite.scrollToStep(s)", step)
                nav_vis = page.evaluate("getComputedStyle(document.getElementById('topNav')).visibility")
                fab_vis = page.evaluate("getComputedStyle(document.getElementById('fab')).visibility")

                if idx == 0:
                    assert nav_vis == "visible", "topNav must be visible on first row"
                    assert fab_vis == "hidden", "bottom fab must be hidden on first row"
                elif idx < len(positions) - 1:
                    assert nav_vis == "hidden", "topNav must be hidden on middle row"
                    assert fab_vis == "hidden", "bottom fab must be hidden on middle row"
                else:
                    assert nav_vis == "hidden", "topNav must be hidden on last row"
                    assert fab_vis == "visible", "bottom fab must be visible on last row"

                png_bytes = page.screenshot(type="png")
                data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
                tiles.append({
                    "row": step["row"],
                    "col": step["col"],
                    "actualX": actual["actualX"],
                    "actualY": actual["actualY"],
                    "bottomOverlays": actual.get("bottomOverlays", []),
                    "dataUrl": data_url,
                })

            page.evaluate("() => window.__gfpLite.cleanup()")
            assert page.evaluate("window.scrollY") == 350, "cleanup() must restore original scrollY"
            assert page.evaluate("getComputedStyle(document.getElementById('topNav')).visibility") == "visible"
            assert page.evaluate("getComputedStyle(document.getElementById('fab')).visibility") == "visible"

            # Stitch inside browser canvas using stitch.js and verify dimensions & pixel colors
            stitched_info = page.evaluate("""async ({ tiles, meta, stitchSrc }) => {
              const modUrl = URL.createObjectURL(new Blob([stitchSrc], { type: 'text/javascript' }));
              const { computeTileDrawOps } = await import(modUrl);
              URL.revokeObjectURL(modUrl);

              const bitmaps = await Promise.all(tiles.map(async (t) => {
                const res = await fetch(t.dataUrl);
                return createImageBitmap(await res.blob());
              }));

              const tilesMeta = tiles.map((t, i) => ({
                row: t.row, col: t.col, actualX: t.actualX, actualY: t.actualY,
                bottomOverlays: t.bottomOverlays,
                imgWidth: bitmaps[i].width, imgHeight: bitmaps[i].height,
              }));

              const { outWidth, outHeight, ops } = computeTileDrawOps(tilesMeta, meta);
              const canvas = document.createElement('canvas');
              canvas.width = outWidth;
              canvas.height = outHeight;
              const ctx = canvas.getContext('2d', { alpha: false });
              for (const op of ops) {
                ctx.drawImage(bitmaps[op.tileIndex], op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh);
              }
              bitmaps.forEach((b) => b.close());

              const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
              return {
                outWidth,
                outHeight,
                topNavPixel: sample(100, 20),
                midNoNavPixel: sample(100, 1220),
                bottomSectionPixel: sample(100, 4100),
                fabPixel: sample(1520, 4120),
              };
            }""", {"tiles": tiles, "meta": meta, "stitchSrc": STITCH_JS})

            assert stitched_info["outWidth"] == 1600, stitched_info
            assert stitched_info["outHeight"] == 4200, stitched_info
            assert stitched_info["topNavPixel"][:3] == [255, 0, 0], stitched_info["topNavPixel"]
            assert stitched_info["midNoNavPixel"][:3] == [240, 240, 240], stitched_info["midNoNavPixel"]
            assert stitched_info["bottomSectionPixel"][:3] == [230, 200, 230], stitched_info["bottomSectionPixel"]
            assert stitched_info["fabPixel"][:3] == [0, 0, 255], stitched_info["fabPixel"]
            page.close()

            # 2. Test nested scroll container with border + container-relative sticky + safe cleanup
            page2 = browser.new_page(viewport={"width": 1000, "height": 700})
            page2.set_content("""
            <!doctype html>
            <html>
            <head>
              <style>
                html, body { margin: 0; height: 100%; overflow: hidden; }
                .shell { display: flex; flex-direction: column; height: 100%; }
                header { height: 60px; background: #111; }
                main { flex: 1; overflow-y: auto; background: #fff; border: 8px solid #333; }
                .csticky { position: sticky; top: 0; height: 32px; background: orange; }
                .tall { height: 1900px; }
                footer { height: 40px; background: #222; }
              </style>
            </head>
            <body>
              <div id="__gfpLiteStyle" hidden>keep-me</div>
              <div class="shell">
                <header>Header</header>
                <main id="scroller" data-gfp-scroll-target="user-attr">
                  <div class="csticky" id="csticky">Container Sticky</div>
                  <div class="tall">Content</div>
                </main>
                <footer>Footer</footer>
              </div>
            </body>
            </html>
            """)
            page2.add_script_tag(content=CAPTURE_JS)
            meta2 = page2.evaluate("() => window.__gfpLite.init()")
            assert meta2["mode"] == "container", f"Expected container mode, got {meta2}"
            assert meta2["containerRect"]["top"] == 68, meta2["containerRect"]
            assert meta2["containerRect"]["left"] == 8, meta2["containerRect"]
            page2.evaluate("(s) => window.__gfpLite.scrollToStep(s)", {
                "x": 0, "y": 500, "isFirstRow": False, "isLastRow": False
            })
            assert page2.evaluate("getComputedStyle(document.getElementById('csticky')).visibility") == "hidden"
            page2.evaluate("() => window.__gfpLite.cleanup()")
            assert page2.evaluate("document.getElementById('__gfpLiteStyle')?.textContent") == "keep-me"
            assert page2.evaluate("document.getElementById('scroller').getAttribute('data-gfp-scroll-target')") == "user-attr"
            page2.close()

            # 3. Test horizontal-only nested scroll container + 810px bottom-fixed footer preservation
            page3 = browser.new_page(viewport={"width": 800, "height": 800})
            page3.set_content("""
            <!doctype html>
            <html>
            <body style="margin:0; height:100%; overflow:hidden;">
              <main style="width:800px; height:600px; overflow-x:auto; overflow-y:hidden;">
                <div style="width:1600px; height:400px;">Wide table</div>
              </main>
            </body>
            </html>
            """)
            page3.add_script_tag(content=CAPTURE_JS)
            meta3 = page3.evaluate("() => window.__gfpLite.init()")
            assert meta3["mode"] == "container", meta3
            assert meta3["contentWidth"] == 1600, meta3
            page3.evaluate("() => window.__gfpLite.cleanup()")
            page3.close()

            # 4. Test 810px page in 800px viewport with 60px bottom-fixed footer (full footer preserved)
            page4 = browser.new_page(viewport={"width": 800, "height": 800})
            page4.set_content("""
            <!doctype html>
            <html>
            <body style="margin:0; background:rgb(240,240,240);">
              <div style="height:810px;"></div>
              <footer style="position:fixed; left:0; right:0; bottom:0; height:60px; background:rgb(0,0,255);"></footer>
            </body>
            </html>
            """)
            page4.add_script_tag(content=CAPTURE_JS)
            meta4 = page4.evaluate("() => window.__gfpLite.init()")
            pos4 = page4.evaluate("""async ({ meta, stitchSrc }) => {
              const modUrl = URL.createObjectURL(new Blob([stitchSrc], { type: 'text/javascript' }));
              const { computeScrollPositions } = await import(modUrl);
              URL.revokeObjectURL(modUrl);
              return computeScrollPositions(meta);
            }""", {"meta": meta4, "stitchSrc": STITCH_JS})
            tiles4 = []
            for step in pos4:
                act = page4.evaluate("(s) => window.__gfpLite.scrollToStep(s)", step)
                png_bytes = page4.screenshot(type="png")
                tiles4.append({
                    "row": step["row"], "col": step["col"],
                    "actualX": act["actualX"], "actualY": act["actualY"],
                    "bottomOverlays": act.get("bottomOverlays", []),
                    "dataUrl": "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii"),
                })
            page4.evaluate("() => window.__gfpLite.cleanup()")
            footer_check = page4.evaluate("""async ({ tiles, meta, stitchSrc }) => {
              const modUrl = URL.createObjectURL(new Blob([stitchSrc], { type: 'text/javascript' }));
              const { computeTileDrawOps } = await import(modUrl);
              URL.revokeObjectURL(modUrl);
              const bmps = await Promise.all(tiles.map(async (t) => createImageBitmap(await (await fetch(t.dataUrl)).blob())));
              const tm = tiles.map((t, i) => ({ ...t, imgWidth: bmps[i].width, imgHeight: bmps[i].height }));
              const { outWidth, outHeight, ops } = computeTileDrawOps(tm, meta);
              const c = document.createElement('canvas');
              c.width = outWidth; c.height = outHeight;
              const ctx = c.getContext('2d', { alpha: false });
              for (const op of ops) ctx.drawImage(bmps[op.tileIndex], op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh);
              bmps.forEach((b) => b.close());
              return {
                outHeight,
                aboveFooter: Array.from(ctx.getImageData(100, 745, 1, 1).data).slice(0, 3),
                footerTop: Array.from(ctx.getImageData(100, 755, 1, 1).data).slice(0, 3),
                footerBottom: Array.from(ctx.getImageData(100, 805, 1, 1).data).slice(0, 3),
              };
            }""", {"tiles": tiles4, "meta": meta4, "stitchSrc": STITCH_JS})
            assert footer_check["outHeight"] == 810, footer_check
            assert footer_check["aboveFooter"] == [240, 240, 240], footer_check
            assert footer_check["footerTop"] == [0, 0, 255], footer_check
            assert footer_check["footerBottom"] == [0, 0, 255], footer_check
            page4.close()

            print("E2E tests passed: window scroll, fixed/sticky hiding, bottom overlay preservation, 2x DPR stitching, safe cleanup, horizontal & bordered container scroll.")
        finally:
            browser.close()


if __name__ == "__main__":
    run_e2e()
