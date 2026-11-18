import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScrollPositions,
  computeTileDrawOps,
  planCanvasChunks,
  clipDrawOpToChunk,
} from '../stitch.js';

test('single viewport page produces 1 tile and ignores 2px subpixel overflow', () => {
  const positions = computeScrollPositions({
    contentWidth: 1281,
    contentHeight: 802,
    viewportWidth: 1280,
    viewportHeight: 800,
  });

  assert.equal(positions.length, 1);
  assert.deepEqual(positions[0], {
    row: 0,
    col: 0,
    x: 0,
    y: 0,
    isFirstRow: true,
    isLastRow: true,
    totalRows: 1,
    totalCols: 1,
  });
});

test('vertical multi-screen page clamps final scroll and crops overlap cleanly at 2x DPR', () => {
  const positions = computeScrollPositions({
    contentWidth: 1280,
    contentHeight: 2500,
    viewportWidth: 1280,
    viewportHeight: 1000,
  });

  assert.deepEqual(
    positions.map((p) => [p.x, p.y, p.isFirstRow, p.isLastRow]),
    [
      [0, 0, true, false],
      [0, 1000, false, false],
      [0, 1500, false, true],
    ]
  );

  const tiles = positions.map((p) => ({
    row: p.row,
    col: p.col,
    actualX: p.x,
    actualY: p.y,
    imgWidth: 2560,
    imgHeight: 2000,
  }));

  const stitched = computeTileDrawOps(tiles, {
    viewportWidth: 1280,
    viewportHeight: 1000,
    mode: 'window',
  });

  assert.equal(stitched.outWidth, 2560);
  assert.equal(stitched.outHeight, 5000);
  assert.equal(stitched.ops.length, 3);

  // Tile 0: full [0..2000] -> dst y=0
  assert.deepEqual(stitched.ops[0], {
    tileIndex: 0, sx: 0, sy: 0, sw: 2560, sh: 2000, dx: 0, dy: 0, dw: 2560, dh: 2000,
  });
  // Tile 1: full [0..2000] -> dst y=2000
  assert.deepEqual(stitched.ops[1], {
    tileIndex: 1, sx: 0, sy: 0, sw: 2560, sh: 2000, dx: 0, dy: 2000, dw: 2560, dh: 2000,
  });
  // Tile 2: actualY=1500, prevBottom=2000 -> crop top 500 CSS px (1000 phys px), draw remaining 1000 phys px at dst y=4000
  assert.deepEqual(stitched.ops[2], {
    tileIndex: 2, sx: 0, sy: 1000, sw: 2560, sh: 1000, dx: 0, dy: 4000, dw: 2560, dh: 1000,
  });
});

test('2D horizontal + vertical grid stitches without gaps or overlaps', () => {
  const positions = computeScrollPositions({
    contentWidth: 1500,
    contentHeight: 1400,
    viewportWidth: 1000,
    viewportHeight: 800,
  });

  assert.equal(positions.length, 4);
  const tiles = positions.map((p) => ({
    row: p.row,
    col: p.col,
    actualX: p.x,
    actualY: p.y,
    imgWidth: 1000,
    imgHeight: 800,
  }));

  const stitched = computeTileDrawOps(tiles, {
    viewportWidth: 1000,
    viewportHeight: 800,
    mode: 'window',
  });

  assert.equal(stitched.outWidth, 1500);
  assert.equal(stitched.outHeight, 1400);
  // Bottom-right tile (actualX=500, actualY=600) should crop 500px from left and 200px from top
  assert.deepEqual(stitched.ops[3], {
    tileIndex: 3, sx: 500, sy: 200, sw: 500, sh: 600, dx: 1000, dy: 800, dw: 500, dh: 600,
  });
});

test('container scroll mode stitches inner scroll area plus outer chrome', () => {
  const containerRect = { left: 200, top: 60, width: 800, height: 700 };
  const positions = computeScrollPositions({
    contentWidth: 800,
    contentHeight: 1600,
    viewportWidth: 1000,
    viewportHeight: 800,
    stepWidth: containerRect.width,
    stepHeight: containerRect.height,
  });

  assert.deepEqual(
    positions.map((p) => [p.x, p.y]),
    [[0, 0], [0, 700], [0, 900]]
  );

  const tiles = positions.map((p) => ({
    row: p.row,
    col: p.col,
    actualX: p.x,
    actualY: p.y,
    imgWidth: 1000,
    imgHeight: 800,
  }));

  const stitched = computeTileDrawOps(tiles, {
    viewportWidth: 1000,
    viewportHeight: 800,
    mode: 'container',
    containerRect,
  });

  // Total height = top(60) + innerScrollHeight(1600) + bottom(40) = 1700
  assert.equal(stitched.outWidth, 1000);
  assert.equal(stitched.outHeight, 1700);

  // Verify bottom chrome op lands at dy = 60 + 1600 = 1660 with height 40
  const bottomOp = stitched.ops[stitched.ops.length - 1];
  assert.deepEqual(bottomOp, {
    tileIndex: 2, sx: 0, sy: 760, sw: 1000, sh: 40, dx: 0, dy: 1660, dw: 1000, dh: 40,
  });
});

test('planCanvasChunks and clipDrawOpToChunk split oversized captures across chunks', () => {
  const chunks = planCanvasChunks(2000, 35000, 16384, 200_000_000);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => [c.y, c.height]), [
    [0, 16384],
    [16384, 16384],
    [32768, 2232],
  ]);

  const straddlingOp = {
    tileIndex: 5,
    sx: 0,
    sy: 0,
    sw: 2000,
    sh: 1000,
    dx: 0,
    dy: 16000,
    dw: 2000,
    dh: 1000,
  };

  const part0 = clipDrawOpToChunk(straddlingOp, chunks[0]);
  const part1 = clipDrawOpToChunk(straddlingOp, chunks[1]);
  const part2 = clipDrawOpToChunk(straddlingOp, chunks[2]);

  assert.deepEqual(part0, {
    tileIndex: 5, sx: 0, sy: 0, sw: 2000, sh: 384, dx: 0, dy: 16000, dw: 2000, dh: 384,
  });
  assert.deepEqual(part1, {
    tileIndex: 5, sx: 0, sy: 384, sw: 2000, sh: 616, dx: 0, dy: 0, dw: 2000, dh: 616,
  });
  assert.equal(part2, null);
});

test('visible mode draws single viewport tile without scrolling or cropping', () => {
  const resWithViewport = computeTileDrawOps(
    [{ row: 0, col: 0, actualX: 0, actualY: 0, imgWidth: 2560, imgHeight: 1600 }],
    { mode: 'visible', viewportWidth: 1280, viewportHeight: 800 }
  );
  assert.equal(resWithViewport.outWidth, 2560);
  assert.equal(resWithViewport.outHeight, 1600);
  assert.equal(resWithViewport.scaleX, 2);
  assert.deepEqual(resWithViewport.ops, [
    { tileIndex: 0, sx: 0, sy: 0, sw: 2560, sh: 1600, dx: 0, dy: 0, dw: 2560, dh: 1600 },
  ]);

  const resFallbackDpr = computeTileDrawOps(
    [{ row: 0, col: 0, actualX: 0, actualY: 0, imgWidth: 1920, imgHeight: 1080 }],
    { mode: 'visible', viewportWidth: 0, viewportHeight: 0, devicePixelRatio: 1.5 }
  );
  assert.equal(resFallbackDpr.scaleX, 1.5);
  assert.equal(resFallbackDpr.outWidth, 1920);
  assert.equal(resFallbackDpr.outHeight, 1080);
});

test('fractional 1.25x scale leaves zero unpainted bottom row on 806px page', () => {
  const meta = {
    mode: 'window',
    viewportWidth: 800,
    viewportHeight: 800,
    contentWidth: 800,
    contentHeight: 806,
  };
  const positions = computeScrollPositions(meta);
  const tiles = positions.map((p) => ({
    row: p.row,
    col: p.col,
    actualX: p.x,
    actualY: p.y,
    imgWidth: 1000,
    imgHeight: 1000,
  }));
  const res = computeTileDrawOps(tiles, meta);
  assert.equal(res.outHeight, 1008);
  const last = res.ops[res.ops.length - 1];
  assert.equal(last.dy + last.dh, 1008);
});

test('bottom-fixed overlay is preserved in full despite small 10px final overlap', () => {
  const meta = {
    mode: 'window',
    viewportWidth: 800,
    viewportHeight: 800,
    contentWidth: 800,
    contentHeight: 810,
  };
  const tiles = [
    { row: 0, col: 0, actualX: 0, actualY: 0, imgWidth: 800, imgHeight: 800 },
    {
      row: 1,
      col: 0,
      actualX: 0,
      actualY: 10,
      imgWidth: 800,
      imgHeight: 800,
      bottomOverlays: [{ left: 0, top: 740, width: 800, height: 60 }],
    },
  ];
  const res = computeTileDrawOps(tiles, meta);
  assert.equal(res.outHeight, 810);
  const footerOp = res.ops[res.ops.length - 1];
  assert.deepEqual(footerOp, {
    tileIndex: 1, sx: 0, sy: 740, sw: 800, sh: 60, dx: 0, dy: 750, dw: 800, dh: 60,
  });
});

test('horizontal overflow threshold ignores minor overflow and RTL negative scrollLeft normalizes cleanly', () => {
  const minorOverflow = computeScrollPositions({
    contentWidth: 1010,
    contentHeight: 800,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.equal(minorOverflow.length, 1);

  const rtlPositions = computeScrollPositions({
    contentWidth: 1500,
    contentHeight: 800,
    viewportWidth: 1000,
    viewportHeight: 800,
    isRtl: true,
  });
  assert.deepEqual(rtlPositions.map((p) => p.x), [0, -500]);

  const rtlTiles = rtlPositions.map((p) => ({
    row: p.row,
    col: p.col,
    actualX: p.x,
    actualY: p.y,
    imgWidth: 1000,
    imgHeight: 800,
  }));
  const rtlRes = computeTileDrawOps(rtlTiles, {
    mode: 'window',
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.equal(rtlRes.outWidth, 1500);
  // First captured tile (actualX=0, rightmost) lands at dx=500..1500; second (actualX=-500, leftmost) draws dx=0..500
  assert.equal(rtlRes.ops[0].dx, 500);
  assert.equal(rtlRes.ops[1].dx, 0);
  assert.equal(rtlRes.ops[1].dw, 500);
});

test('planCanvasChunks splits oversized width into 2D grid chunks', () => {
  const chunks = planCanvasChunks(20000, 1000, 16384, 200_000_000);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => [c.x, c.y, c.width, c.height, c.totalCols]), [
    [0, 0, 16384, 1000, 2],
    [16384, 0, 3616, 1000, 2],
  ]);

  const wideOp = { tileIndex: 0, sx: 0, sy: 0, sw: 20000, sh: 500, dx: 0, dy: 0, dw: 20000, dh: 500 };
  assert.deepEqual(clipDrawOpToChunk(wideOp, chunks[0]), {
    tileIndex: 0, sx: 0, sy: 0, sw: 16384, sh: 500, dx: 0, dy: 0, dw: 16384, dh: 500,
  });
  assert.deepEqual(clipDrawOpToChunk(wideOp, chunks[1]), {
    tileIndex: 0, sx: 16384, sy: 0, sw: 3616, sh: 500, dx: 0, dy: 0, dw: 3616, dh: 500,
  });
});
