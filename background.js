import { computeScrollPositions } from './stitch.js';

const QUOTA_CALLS = 2;
const QUOTA_WINDOW_MS = 1020;
const CAPTURE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TITLE = 'Screenshot (Full Page / What You See)';

const activeCaptures = new Map();
const completedCaptures = new Map();
const globalCaptureStarts = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setBadgeColor(tabId, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {}
}

async function setBadgeText(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) {}
}

async function showErrorBadge(tabId, title) {
  await setBadgeColor(tabId, '#dc2626');
  await setBadgeText(tabId, 'ERR');
  try {
    await chrome.action.setTitle({ tabId, title });
  } catch (_) {}
  setTimeout(async () => {
    await setBadgeText(tabId, '');
    try {
      await chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
    } catch (_) {}
  }, 3500);
}

async function acquireQuotaSlot(job) {
  while (globalCaptureStarts.length >= QUOTA_CALLS) {
    if (job.cancelled) return false;
    const waitMs = globalCaptureStarts[0] + QUOTA_WINDOW_MS - Date.now();
    if (waitMs <= 0) {
      globalCaptureStarts.shift();
      break;
    }
    await sleep(waitMs);
  }
  if (job.cancelled) return false;
  globalCaptureStarts.push(Date.now());
  if (globalCaptureStarts.length > QUOTA_CALLS) {
    globalCaptureStarts.shift();
  }
  return true;
}

async function isTabStillActive(tabId, windowId) {
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    return active?.id === tabId;
  } catch (_) {
    return false;
  }
}

async function captureVisibleWithRetry(tabId, windowId, job) {
  let attempt = 0;
  while (true) {
    if (job.cancelled) return null;
    const okSlot = await acquireQuotaSlot(job);
    if (!okSlot || job.cancelled) return null;

    if (!(await isTabStillActive(tabId, windowId))) {
      job.cancelled = true;
      return null;
    }

    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const msg = String(err?.message || err);
      const isQuota = /quota|MAX_CAPTURE_VISIBLE_TAB/i.test(msg);
      if (isQuota && attempt < 3) {
        attempt++;
        await sleep(550 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function openViewer(tab, meta, tiles) {
  const captureId = crypto.randomUUID();
  const timeoutId = setTimeout(() => {
    completedCaptures.delete(captureId);
  }, CAPTURE_TTL_MS);

  completedCaptures.set(captureId, { meta, tiles, timeoutId });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`viewer.html?id=${encodeURIComponent(captureId)}`),
    windowId: tab.windowId,
    index: typeof tab.index === 'number' ? tab.index + 1 : undefined,
  });
}

async function runVisibleCapture(tab, job) {
  await setBadgeColor(tab.id, '#2563eb');
  await setBadgeText(tab.id, '...');
  const dataUrl = await captureVisibleWithRetry(tab.id, tab.windowId, job);
  if (!dataUrl || job.cancelled) return;

  const meta = {
    mode: 'visible',
    viewportWidth: tab.width || 0,
    viewportHeight: tab.height || 0,
    title: tab.title || '',
    url: tab.url || '',
    backgroundColor: '#ffffff',
  };

  await setBadgeColor(tab.id, '#16a34a');
  await setBadgeText(tab.id, '100%');
  await openViewer(tab, meta, [
    { row: 0, col: 0, actualX: 0, actualY: 0, bottomOverlays: [], dataUrl },
  ]);
}

async function runFullPageCapture(tab, job) {
  const tabId = tab.id;
  await setBadgeColor(tabId, '#2563eb');
  await setBadgeText(tabId, '...');
  try {
    await chrome.action.setPopup({ tabId, popup: '' });
    await chrome.action.setTitle({ tabId, title: 'Capturing page... Click to cancel' });
  } catch (_) {}

  const [{ result: meta }] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['capture.js'],
  });

  const positions = computeScrollPositions(meta);
  const tiles = [];
  let prevRowY = -1;

  for (let i = 0; i < positions.length; i++) {
    if (job.cancelled) break;

    const step = positions[i];
    if (positions.length > 1) {
      await setBadgeText(tabId, `${Math.round((i / positions.length) * 100)}%`);
    }

    const [{ result: actual }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (arg) => window.__gfpLite.scrollToStep(arg),
      args: [step],
    });

    if (job.cancelled) break;

    // If scroll clamped at the previous row's Y, stop early instead of repeating clamped shots.
    if (step.row > 0 && step.col === 0 && step.totalCols === 1 && actual.actualY <= prevRowY) {
      if (!step.isLastRow && tiles.length > 0) {
        const [{ result: finalActual }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (arg) => window.__gfpLite.scrollToStep(arg),
          args: [{ ...step, y: prevRowY, isLastRow: true }],
        });
        if (!job.cancelled) {
          const finalUrl = await captureVisibleWithRetry(tabId, tab.windowId, job);
          if (finalUrl && !job.cancelled) {
            const prev = tiles[tiles.length - 1];
            tiles[tiles.length - 1] = {
              row: prev.row,
              col: prev.col,
              actualX: finalActual.actualX,
              actualY: finalActual.actualY,
              bottomOverlays: finalActual.bottomOverlays || [],
              dataUrl: finalUrl,
            };
          }
        }
      }
      break;
    }

    if (step.col === 0) {
      prevRowY = actual.actualY;
    }

    const dataUrl = await captureVisibleWithRetry(tabId, tab.windowId, job);
    if (!dataUrl || job.cancelled) break;

    tiles.push({
      row: step.row,
      col: step.col,
      actualX: actual.actualX,
      actualY: actual.actualY,
      bottomOverlays: actual.bottomOverlays || [],
      dataUrl,
    });
  }

  if (!job.cancelled && tiles.length > 0) {
    await setBadgeColor(tabId, '#16a34a');
    await setBadgeText(tabId, '100%');
    await openViewer(tab, meta, tiles);
  }
}

async function runCapture(tab, mode = 'full') {
  if (!tab?.id) return;
  const tabId = tab.id;

  const existing = activeCaptures.get(tabId);
  if (existing) {
    existing.cancelled = true;
    await setBadgeColor(tabId, '#64748b');
    await setBadgeText(tabId, '...');
    return;
  }

  const job = { cancelled: false, windowId: tab.windowId };
  activeCaptures.set(tabId, job);
  let hadError = false;

  try {
    if (mode === 'visible') {
      await runVisibleCapture(tab, job);
    } else {
      await runFullPageCapture(tab, job);
    }
  } catch (err) {
    hadError = true;
    console.error('[GoFullPage Lite]', err);
    await showErrorBadge(tabId, `Capture failed: ${err?.message || err}`);
  } finally {
    if (mode !== 'visible') {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.__gfpLite?.cleanup(),
        });
      } catch (_) {}
    }

    activeCaptures.delete(tabId);
    try {
      await chrome.action.setPopup({ tabId, popup: 'popup.html' });
    } catch (_) {}

    if (!hadError) {
      await setBadgeText(tabId, '');
      try {
        await chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
      } catch (_) {}
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const job = activeCaptures.get(tabId);
  if (job) {
    job.cancelled = true;
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  for (const [tabId, job] of activeCaptures) {
    if (job.windowId === activeInfo.windowId && tabId !== activeInfo.tabId) {
      job.cancelled = true;
    }
  }
});

// Fires when popup is temporarily cleared during an active full-page capture.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const existing = activeCaptures.get(tab.id);
  if (existing) {
    existing.cancelled = true;
    await setBadgeColor(tab.id, '#64748b');
    await setBadgeText(tab.id, '...');
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-visible') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    void runCapture(tab, 'visible');
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'startCapture' && msg.tab?.id) {
    void runCapture(msg.tab, msg.mode === 'visible' ? 'visible' : 'full');
    sendResponse({ ok: true });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'viewer') return;

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'getCapture') {
      const entry = completedCaptures.get(msg.id);
      if (!entry) {
        port.postMessage({ type: 'error', message: 'Capture data expired or not found.' });
        return;
      }

      const tileDescs = entry.tiles.map(({ dataUrl: _dataUrl, ...rest }) => rest);
      port.postMessage({
        type: 'meta',
        meta: entry.meta,
        tileDescs,
        totalTiles: entry.tiles.length,
      });
      return;
    }

    if (msg?.type === 'getTile') {
      const entry = completedCaptures.get(msg.id);
      if (!entry || !entry.tiles[msg.index]) {
        port.postMessage({ type: 'error', message: 'Capture tile missing or expired.' });
        return;
      }
      port.postMessage({
        type: 'tile',
        index: msg.index,
        dataUrl: entry.tiles[msg.index].dataUrl,
      });
      return;
    }

    if (msg?.type === 'ack') {
      const entry = completedCaptures.get(msg.id);
      if (entry) {
        clearTimeout(entry.timeoutId);
        completedCaptures.delete(msg.id);
      }
    }
  });
});
