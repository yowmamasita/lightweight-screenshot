/**
 * Pure scroll planning and tile-stitching geometry helpers.
 * Shared by background.js, viewer.js, and unit tests.
 */

export const MAX_CANVAS_DIM = 16384;
export const MAX_CANVAS_AREA = 200_000_000;
export const DEFAULT_HORIZONTAL_OVERFLOW_THRESHOLD = 16;

/**
 * Build the list of scroll coordinates for full-page capture.
 */
export function computeScrollPositions({
  contentWidth,
  contentHeight,
  viewportWidth,
  viewportHeight,
  stepWidth = viewportWidth,
  stepHeight = viewportHeight,
  captureHorizontal = true,
  horizontalOverflowThreshold = DEFAULT_HORIZONTAL_OVERFLOW_THRESHOLD,
  isRtl = false,
}) {
  const sw = Math.max(1, Math.floor(stepWidth));
  const sh = Math.max(1, Math.floor(stepHeight));
  const cw = Math.max(sw, Math.ceil(contentWidth));
  const ch = Math.max(sh, Math.ceil(contentHeight));

  const maxScrollX = Math.max(0, cw - sw);
  const maxScrollY = Math.max(0, ch - sh);

  const xs = buildAxisSteps(
    maxScrollX,
    sw,
    captureHorizontal ? horizontalOverflowThreshold : Infinity
  ).map((x) => (isRtl && x > 0 ? -x : x));

  const ys = buildAxisSteps(maxScrollY, sh, 2);

  const positions = [];
  for (let row = 0; row < ys.length; row++) {
    for (let col = 0; col < xs.length; col++) {
      positions.push({
        row,
        col,
        x: xs[col],
        y: ys[row],
        isFirstRow: row === 0,
        isLastRow: row === ys.length - 1,
        totalRows: ys.length,
        totalCols: xs.length,
      });
    }
  }
  return positions;
}

function buildAxisSteps(maxScroll, step, minOverflow) {
  if (maxScroll <= minOverflow) {
    return [0];
  }
  const steps = [0];
  let pos = step;
  while (pos < maxScroll) {
    steps.push(pos);
    pos += step;
  }
  if (steps[steps.length - 1] !== maxScroll) {
    steps.push(maxScroll);
  }
  return steps;
}

/**
 * Compute output dimensions (physical pixels) and drawImage operations for captured tiles.
 *
 * Each tile: { row, col, actualX, actualY, imgWidth, imgHeight, bottomOverlays? }
 * Meta: { viewportWidth, viewportHeight, mode: 'window'|'container'|'visible', containerRect? }
 */
export function computeTileDrawOps(tiles, meta) {
  if (!tiles || tiles.length === 0) {
    throw new Error('No captured tiles to stitch');
  }

  if (meta.mode === 'visible') {
    const t = tiles[0];
    const scaleX = meta.viewportWidth ? t.imgWidth / meta.viewportWidth : (meta.devicePixelRatio || 1);
    const scaleY = meta.viewportHeight ? t.imgHeight / meta.viewportHeight : scaleX;
    return {
      outWidth: t.imgWidth,
      outHeight: t.imgHeight,
      scaleX,
      scaleY,
      ops: [
        {
          tileIndex: 0,
          sx: 0,
          sy: 0,
          sw: t.imgWidth,
          sh: t.imgHeight,
          dx: 0,
          dy: 0,
          dw: t.imgWidth,
          dh: t.imgHeight,
        },
      ],
    };
  }

  const vw = Math.max(1, meta.viewportWidth);
  const vh = Math.max(1, meta.viewportHeight);
  const scaleX = tiles[0].imgWidth / vw;
  const scaleY = tiles[0].imgHeight / vh;

  const isContainer = meta.mode === 'container' && meta.containerRect && tiles.length > 1;
  const rect = isContainer ? meta.containerRect : { left: 0, top: 0, width: vw, height: vh };

  // Normalize negative scrollLeft (RTL pages) by shifting origin left by -minActualX.
  let minActualX = 0;
  let maxActualX = 0;
  let maxActualY = 0;
  for (const t of tiles) {
    if (t.actualX < minActualX) minActualX = t.actualX;
    if (t.actualX > maxActualX) maxActualX = t.actualX;
    if (t.actualY > maxActualY) maxActualY = t.actualY;
  }
  const shiftX = -minActualX;

  const outCssW = vw + (maxActualX - minActualX);
  const outCssH = vh + maxActualY;
  const outWidth = Math.max(1, Math.round(outCssW * scaleX));
  const outHeight = Math.max(1, Math.round(outCssH * scaleY));

  const indexed = tiles.map((tile, tileIndex) => ({ tile, tileIndex }));
  indexed.sort((a, b) => (a.tile.row - b.tile.row) || (a.tile.col - b.tile.col));

  const ops = [];
  const rowCoveredBottom = new Map();
  const colCoveredBounds = new Map();

  if (!isContainer) {
    let lastRowTiles = [];
    let maxRow = 0;

    for (const { tile: t, tileIndex } of indexed) {
      if (t.row > maxRow) {
        maxRow = t.row;
        lastRowTiles = [];
      }
      if (t.row === maxRow) {
        lastRowTiles.push({ tile: t, tileIndex });
      }

      const normX = t.actualX + shiftX;
      const prevRowEnd = t.row > 0 ? (rowCoveredBottom.get(t.row - 1) ?? 0) : 0;
      const prevCol = t.col > 0 ? colCoveredBounds.get(t.col - 1) : null;

      const cropTopCss = Math.max(0, Math.min(vh, prevRowEnd - t.actualY));
      let cropLeftCss = 0;
      let cropRightCss = 0;
      if (prevCol) {
        if (normX >= prevCol.left) {
          cropLeftCss = Math.max(0, Math.min(vw, prevCol.right - normX));
        } else {
          cropRightCss = Math.max(0, Math.min(vw, (normX + vw) - prevCol.left));
        }
      }

      const drawWCss = vw - cropLeftCss - cropRightCss;
      const drawHCss = vh - cropTopCss;
      const op = makeEdgeAlignedOp(
        tileIndex,
        cropLeftCss,
        cropTopCss,
        drawWCss,
        drawHCss,
        normX + cropLeftCss,
        t.actualY + cropTopCss,
        scaleX,
        scaleY,
        t.imgWidth,
        t.imgHeight,
        outWidth,
        outHeight
      );
      if (op) ops.push(op);

      rowCoveredBottom.set(t.row, Math.max(rowCoveredBottom.get(t.row) ?? 0, t.actualY + vh));
      const curCol = colCoveredBounds.get(t.col);
      colCoveredBounds.set(t.col, {
        left: curCol ? Math.min(curCol.left, normX) : normX,
        right: curCol ? Math.max(curCol.right, normX + vw) : normX + vw,
      });
    }

    // Repaint bottom-fixed overlays from the final row so small final overlaps never slice footers.
    for (const { tile: t, tileIndex } of lastRowTiles) {
      if (!t.bottomOverlays || t.bottomOverlays.length === 0) continue;
      const normX = t.actualX + shiftX;
      for (const ov of t.bottomOverlays) {
        const op = makeEdgeAlignedOp(
          tileIndex,
          ov.left,
          ov.top,
          ov.width,
          ov.height,
          normX + ov.left,
          t.actualY + ov.top,
          scaleX,
          scaleY,
          t.imgWidth,
          t.imgHeight,
          outWidth,
          outHeight
        );
        if (op) ops.push(op);
      }
    }

    return { outWidth, outHeight, scaleX, scaleY, ops };
  }

  // Container scroll mode (>1 tile)
  const firstEntry = indexed[0];
  const lastEntry = indexed[indexed.length - 1];
  const rectRight = rect.left + rect.width;
  const rectBottom = rect.top + rect.height;

  if (rect.top > 0) {
    const op = makeEdgeAlignedOp(
      firstEntry.tileIndex,
      0, 0, vw, rect.top,
      0, 0,
      scaleX, scaleY,
      firstEntry.tile.imgWidth, firstEntry.tile.imgHeight,
      outWidth, outHeight
    );
    if (op) ops.push(op);
  }
  if (rect.left > 0) {
    const op = makeEdgeAlignedOp(
      firstEntry.tileIndex,
      0, rect.top, rect.left, rect.height,
      0, rect.top,
      scaleX, scaleY,
      firstEntry.tile.imgWidth, firstEntry.tile.imgHeight,
      outWidth, outHeight
    );
    if (op) ops.push(op);
  }

  for (const { tile: t, tileIndex } of indexed) {
    const normX = t.actualX + shiftX;
    const prevRowEnd = t.row > 0 ? (rowCoveredBottom.get(t.row - 1) ?? 0) : 0;
    const prevCol = t.col > 0 ? colCoveredBounds.get(t.col - 1) : null;

    const cropTopCss = Math.max(0, Math.min(rect.height, prevRowEnd - t.actualY));
    let cropLeftCss = 0;
    let cropRightCss = 0;
    if (prevCol) {
      if (normX >= prevCol.left) {
        cropLeftCss = Math.max(0, Math.min(rect.width, prevCol.right - normX));
      } else {
        cropRightCss = Math.max(0, Math.min(rect.width, (normX + rect.width) - prevCol.left));
      }
    }

    const op = makeEdgeAlignedOp(
      tileIndex,
      rect.left + cropLeftCss,
      rect.top + cropTopCss,
      rect.width - cropLeftCss - cropRightCss,
      rect.height - cropTopCss,
      rect.left + normX + cropLeftCss,
      rect.top + t.actualY + cropTopCss,
      scaleX,
      scaleY,
      t.imgWidth,
      t.imgHeight,
      outWidth,
      outHeight
    );
    if (op) ops.push(op);

    rowCoveredBottom.set(t.row, Math.max(rowCoveredBottom.get(t.row) ?? 0, t.actualY + rect.height));
    const curCol = colCoveredBounds.get(t.col);
    colCoveredBounds.set(t.col, {
      left: curCol ? Math.min(curCol.left, normX) : normX,
      right: curCol ? Math.max(curCol.right, normX + rect.width) : normX + rect.width,
    });
  }

  if (rectRight < vw) {
    const op = makeEdgeAlignedOp(
      lastEntry.tileIndex,
      rectRight, rect.top, vw - rectRight, rect.height,
      rectRight + (maxActualX - minActualX), rect.top,
      scaleX, scaleY,
      lastEntry.tile.imgWidth, lastEntry.tile.imgHeight,
      outWidth, outHeight
    );
    if (op) ops.push(op);
  }

  if (rectBottom < vh) {
    const op = makeEdgeAlignedOp(
      lastEntry.tileIndex,
      0, rectBottom, vw, vh - rectBottom,
      0, rectBottom + maxActualY,
      scaleX, scaleY,
      lastEntry.tile.imgWidth, lastEntry.tile.imgHeight,
      outWidth, outHeight
    );
    if (op) ops.push(op);
  }

  return { outWidth, outHeight, scaleX, scaleY, ops };
}

/**
 * Derive pixel bounds from rounded start and end edges so fractional scales never leave 1px seams.
 */
function makeEdgeAlignedOp(
  tileIndex,
  srcXCss,
  srcYCss,
  wCss,
  hCss,
  dstXCss,
  dstYCss,
  scaleX,
  scaleY,
  imgW,
  imgH,
  outW,
  outH
) {
  if (wCss <= 0 || hCss <= 0) return null;

  const dx = Math.max(0, Math.round(dstXCss * scaleX));
  const dy = Math.max(0, Math.round(dstYCss * scaleY));
  const dxEnd = Math.min(outW, Math.round((dstXCss + wCss) * scaleX));
  const dyEnd = Math.min(outH, Math.round((dstYCss + hCss) * scaleY));
  const dw = dxEnd - dx;
  const dh = dyEnd - dy;
  if (dw <= 0 || dh <= 0) return null;

  const sxEnd = Math.min(imgW, Math.round((srcXCss + wCss) * scaleX));
  const syEnd = Math.min(imgH, Math.round((srcYCss + hCss) * scaleY));
  const sx = Math.max(0, Math.min(Math.round(srcXCss * scaleX), sxEnd - dw));
  const sy = Math.max(0, Math.min(Math.round(srcYCss * scaleY), syEnd - dh));
  const sw = Math.min(dw, sxEnd - sx);
  const sh = Math.min(dh, syEnd - sy);
  if (sw <= 0 || sh <= 0) return null;

  return { tileIndex, sx, sy, sw, sh, dx, dy, dw, dh };
}

/**
 * Split oversized output dimensions into 2D canvas chunks within browser limits.
 */
export function planCanvasChunks(
  outWidth,
  outHeight,
  maxDim = MAX_CANVAS_DIM,
  maxArea = MAX_CANVAS_AREA
) {
  const chunkW = Math.max(1, Math.min(maxDim, outWidth));
  const safeMaxH = Math.max(1, Math.min(maxDim, Math.floor(maxArea / chunkW)));

  const xs = [];
  for (let x = 0; x < outWidth; x += chunkW) {
    xs.push({ x, width: Math.min(chunkW, outWidth - x) });
  }

  const ys = [];
  for (let y = 0; y < outHeight; y += safeMaxH) {
    ys.push({ y, height: Math.min(safeMaxH, outHeight - y) });
  }

  const chunks = [];
  let index = 0;
  for (let row = 0; row < ys.length; row++) {
    for (let col = 0; col < xs.length; col++) {
      chunks.push({
        index,
        row,
        col,
        totalRows: ys.length,
        totalCols: xs.length,
        x: xs[col].x,
        y: ys[row].y,
        width: xs[col].width,
        height: ys[row].height,
      });
      index++;
    }
  }
  return chunks;
}

/**
 * Clip a draw operation against a canvas chunk, returning chunk-local coordinates or null.
 */
export function clipDrawOpToChunk(op, chunk) {
  const chunkX = chunk.x ?? 0;
  const chunkY = chunk.y ?? 0;

  const interLeft = Math.max(op.dx, chunkX);
  const interRight = Math.min(op.dx + op.dw, chunkX + chunk.width);
  if (interRight <= interLeft) return null;

  const interTop = Math.max(op.dy, chunkY);
  const interBottom = Math.min(op.dy + op.dh, chunkY + chunk.height);
  if (interBottom <= interTop) return null;

  const leftOffset = interLeft - op.dx;
  const topOffset = interTop - op.dy;
  const clippedW = interRight - interLeft;
  const clippedH = interBottom - interTop;

  return {
    tileIndex: op.tileIndex,
    sx: op.sx + leftOffset,
    sy: op.sy + topOffset,
    sw: clippedW,
    sh: clippedH,
    dx: interLeft - chunkX,
    dy: interTop - chunkY,
    dw: clippedW,
    dh: clippedH,
  };
}
