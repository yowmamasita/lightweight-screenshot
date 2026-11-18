async function trigger(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    window.close();
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: 'startCapture',
      mode,
      tab: {
        id: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        title: tab.title || '',
        url: tab.url || '',
        width: tab.width || 0,
        height: tab.height || 0,
      },
    },
    () => {
      void chrome.runtime.lastError;
      window.close();
    }
  );
}

for (const btn of document.querySelectorAll('.item')) {
  btn.addEventListener('click', () => trigger(btn.dataset.mode));
}

document.addEventListener('keydown', (e) => {
  if (e.key === '1') {
    trigger('full');
  } else if (e.key === '2') {
    trigger('visible');
  } else if (e.key === 'Escape') {
    window.close();
  }
});
