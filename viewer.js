import {
  computeTileDrawOps,
  planCanvasChunks,
  clipDrawOpToChunk,
} from './stitch.js';

const TILE_BATCH_SIZE = 4;

const titleEl = document.getElementById('pageTitle');
const statsEl = document.getElementById('pageStats');
const statusEl = document.getElementById('status');
const stackEl = document.getElementById('canvasStack');
const stageEl = document.getElementById('stage');
const zoomBtn = document.getElementById('zoomBtn');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');

let blobs = [];
const objectUrls = [];
let baseFilename = 'screenshot';
let isActualZoom = false;
let cssWidth = 0;
let rawWidth = 0;
let gridCols = 1;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function makeBaseFilename(meta) {
  let host = 'page';
  try {
    host = new URL(meta.url).hostname.replace(/^www\./, '') || 'page';
  } catch (_) {}
  const cleanHost = host.replace(/[^a-zA-Z0-9.-]+/g, '-').slice(0, 60);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${cleanHost}_${stamp}`;
}

function dataUrlToBlob(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'image/png' });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode PNG'));
    }, 'image/png');
  });
}

function setElementZoomSizing(el, naturalW) {
  if (isActualZoom) {
    el.style.width = `${naturalW}px`;
    el.style.maxWidth = 'none';
    el.style.height = 'auto';
  } else if (gridCols === 1) {
    el.style.width = `${Math.round((naturalW / rawWidth) * cssWidth)}px`;
    el.style.maxWidth = '100%';
    el.style.height = 'auto';
  } else {
    el.style.width = `${Math.round((naturalW / rawWidth) * cssWidth)}px`;
    el.style.maxWidth = 'none';
    el.style.height = 'auto';
  }
}

function applyZoom() {
  stageEl.classList.toggle('actual', isActualZoom);
  zoomBtn.textContent = isActualZoom ? '100%' : 'Fit';
  for (const el of stackEl.children) {
    const w = Number(el.dataset.rawWidth) || rawWidth;
    setElementZoomSizing(el, w);
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function downloadAll() {
  if (blobs.length === 0) return;
  if (blobs.length === 1) {
    triggerDownload(blobs[0], `${baseFilename}.png`);
    return;
  }
  for (let i = 0; i < blobs.length; i++) {
    triggerDownload(blobs[i], `${baseFilename}_part${i + 1}.png`);
    if (i < blobs.length - 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function copyImage() {
  if (blobs.length === 0) return;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blobs[0] }),
    ]);
    const prev = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = prev;
    }, 1500);
  } catch (err) {
    copyBtn.textContent = 'Failed';
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
    }, 1500);
    console.error('[Lightweight Screenshot] Copy failed:', err);
  }
}

function showError(msg) {
  statusEl.textContent = msg;
  statusEl.classList.add('error');
  statusEl.hidden = false;
  titleEl.textContent = 'Capture Error';
}

function finishControls(outWidth, outHeight, totalParts) {
  const totalBytes = blobs.reduce((sum, b) => sum + b.size, 0);
  const partsNote = totalParts > 1 ? ` · ${totalParts} parts` : '';
  statsEl.textContent = `${outWidth} × ${outHeight} px · ${formatBytes(totalBytes)}${partsNote}`;

  downloadBtn.disabled = false;
  if (blobs.length > 1) {
    downloadBtn.textContent = `Download ${blobs.length} PNGs`;
    copyBtn.disabled = true;
    copyBtn.title = 'Page split into multiple parts; download PNGs instead';
  } else {
    copyBtn.disabled = false;
  }
}

async function renderSingleFrame(meta, dataUrl, onAck) {
  const blob = dataUrlToBlob(dataUrl);
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);

  const img = new Image();
  img.src = url;
  await img.decode();
  onAck();

  const outWidth = img.naturalWidth;
  const outHeight = img.naturalHeight;
  const scaleX = meta.viewportWidth ? outWidth / meta.viewportWidth : (window.devicePixelRatio || 1);

  rawWidth = outWidth;
  cssWidth = Math.max(1, Math.round(outWidth / scaleX));
  gridCols = 1;
  img.dataset.rawWidth = String(outWidth);

  stackEl.appendChild(img);
  applyZoom();
  statusEl.hidden = true;
  stackEl.hidden = false;
  zoomBtn.disabled = false;

  blobs = [blob];
  finishControls(outWidth, outHeight, 1);
}

async function renderMultiTile(meta, tileDescs, fetchTile, onAck) {
  const firstUrl = await fetchTile(0);
  const firstBmp = await createImageBitmap(dataUrlToBlob(firstUrl));
  const imgW = firstBmp.width;
  const imgH = firstBmp.height;

  const tilesMeta = tileDescs.map((desc) => ({
    ...desc,
    imgWidth: imgW,
    imgHeight: imgH,
  }));

  const { outWidth, outHeight, scaleX, ops } = computeTileDrawOps(tilesMeta, {
    ...meta,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
  const chunks = planCanvasChunks(outWidth, outHeight);

  rawWidth = outWidth;
  cssWidth = Math.max(1, Math.round(outWidth / scaleX));
  gridCols = chunks[0]?.totalCols || 1;
  if (gridCols > 1) {
    stackEl.style.display = 'grid';
    stackEl.style.gridTemplateColumns = `repeat(${gridCols}, auto)`;
  }

  const bg = meta.backgroundColor || '#ffffff';
  const chunkStates = chunks.map((chunk) => {
    const canvas = document.createElement('canvas');
    canvas.width = chunk.width;
    canvas.height = chunk.height;
    canvas.dataset.rawWidth = String(chunk.width);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, chunk.width, chunk.height);
    stackEl.appendChild(canvas);
    return { chunk, canvas, ctx };
  });

  const opsByTile = new Map();
  for (const op of ops) {
    let list = opsByTile.get(op.tileIndex);
    if (!list) {
      list = [];
      opsByTile.set(op.tileIndex, list);
    }
    list.push(op);
  }

  function drawAndCloseTile(tileIndex, bmp) {
    const tileOps = opsByTile.get(tileIndex);
    if (tileOps) {
      for (const op of tileOps) {
        for (const sc of chunkStates) {
          const clipped = clipDrawOpToChunk(op, sc.chunk);
          if (!clipped) continue;
          sc.ctx.drawImage(
            bmp,
            clipped.sx,
            clipped.sy,
            clipped.sw,
            clipped.sh,
            clipped.dx,
            clipped.dy,
            clipped.dw,
            clipped.dh
          );
        }
      }
    }
    bmp.close();
  }

  drawAndCloseTile(0, firstBmp);

  // Pull and decode remaining tiles in bounded batches so peak bitmap memory stays low.
  for (let start = 1; start < tileDescs.length; start += TILE_BATCH_SIZE) {
    const end = Math.min(tileDescs.length, start + TILE_BATCH_SIZE);
    statusEl.textContent = `Stitching frame ${end} / ${tileDescs.length}…`;
    const indices = [];
    for (let idx = start; idx < end; idx++) indices.push(idx);
    const batch = await Promise.all(
      indices.map(async (idx) => {
        const dataUrl = await fetchTile(idx);
        const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
        return { idx, bmp };
      })
    );
    for (const { idx, bmp } of batch) {
      drawAndCloseTile(idx, bmp);
    }
  }

  onAck();

  // Show stitched preview immediately, then encode chunks sequentially and swap canvases for <img>.
  applyZoom();
  statusEl.hidden = true;
  stackEl.hidden = false;
  zoomBtn.disabled = false;
  const partsNote = chunks.length > 1 ? ` · ${chunks.length} parts` : '';
  statsEl.textContent = `${outWidth} × ${outHeight} px · encoding…${partsNote}`;

  blobs = [];
  for (const sc of chunkStates) {
    const blob = await canvasToPngBlob(sc.canvas);
    blobs.push(blob);

    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const img = new Image();
    img.src = url;
    img.dataset.rawWidth = String(sc.chunk.width);
    setElementZoomSizing(img, sc.chunk.width);
    sc.canvas.replaceWith(img);
    sc.canvas.width = 0;
    sc.canvas.height = 0;
  }

  finishControls(outWidth, outHeight, chunks.length);
}

zoomBtn.addEventListener('click', () => {
  isActualZoom = !isActualZoom;
  applyZoom();
});

stackEl.addEventListener('click', () => {
  isActualZoom = !isActualZoom;
  applyZoom();
});

downloadBtn.addEventListener('click', downloadAll);
copyBtn.addEventListener('click', copyImage);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    downloadAll();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
    if (!copyBtn.disabled) {
      e.preventDefault();
      copyImage();
    }
  } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'z') {
    if (!zoomBtn.disabled) {
      isActualZoom = !isActualZoom;
      applyZoom();
    }
  }
});

window.addEventListener('unload', () => {
  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }
});

(function init() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) {
    showError('Missing capture ID.');
    return;
  }

  const port = chrome.runtime.connect({ name: 'viewer' });
  const pendingTiles = new Map();
  let completedTransfer = false;

  function rejectAllPending(err) {
    for (const { reject } of pendingTiles.values()) {
      reject(err);
    }
    pendingTiles.clear();
  }

  function fetchTile(index) {
    return new Promise((resolve, reject) => {
      pendingTiles.set(index, { resolve, reject });
      port.postMessage({ type: 'getTile', id, index });
    });
  }

  port.onDisconnect.addListener(() => {
    if (!completedTransfer) {
      const err = new Error('Connection to extension worker closed before capture finished.');
      rejectAllPending(err);
      showError(err.message);
    }
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'error') {
      completedTransfer = true;
      rejectAllPending(new Error(msg.message));
      showError(msg.message);
      port.disconnect();
      return;
    }

    if (msg.type === 'meta') {
      const { meta, tileDescs, totalTiles } = msg;
      baseFilename = makeBaseFilename(meta);
      titleEl.textContent = meta.title || meta.url || 'Screenshot';
      document.title = `${titleEl.textContent} — Lightweight Screenshot`;
      statusEl.textContent = `Receiving ${totalTiles} frame${totalTiles === 1 ? '' : 's'}…`;

      const ack = () => {
        if (!completedTransfer) {
          completedTransfer = true;
          try {
            port.postMessage({ type: 'ack', id });
            port.disconnect();
          } catch (_) {}
        }
      };

      try {
        if (totalTiles === 1) {
          const url = await fetchTile(0);
          await renderSingleFrame(meta, url, ack);
        } else {
          await renderMultiTile(meta, tileDescs, fetchTile, ack);
        }
      } catch (err) {
        console.error('[Lightweight Screenshot] Render failed:', err);
        showError(`Failed to stitch screenshot: ${err?.message || err}`);
      }
      return;
    }

    if (msg.type === 'tile') {
      const entry = pendingTiles.get(msg.index);
      if (entry) {
        pendingTiles.delete(msg.index);
        entry.resolve(msg.dataUrl);
      }
    }
  });

  port.postMessage({ type: 'getCapture', id });
})();
