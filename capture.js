(() => {
  if (window.__gfpLite) {
    try {
      window.__gfpLite.cleanup();
    } catch (_) {}
  }

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math']);
  let state = null;

  function nextFrames(count = 2) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve();
        }
      }, 100);

      function step(remaining) {
        if (done) return;
        if (remaining <= 0) {
          done = true;
          clearTimeout(timer);
          resolve();
        } else {
          requestAnimationFrame(() => step(remaining - 1));
        }
      }
      step(count);
    });
  }

  function findNestedScrollContainer(vw, vh) {
    const candidates = document.querySelectorAll('main, [role="main"], section, article, div');
    let best = null;
    let bestArea = 0;

    for (const el of candidates) {
      if (el === document.body || el === document.documentElement) continue;
      const cs = getComputedStyle(el);
      const canScrollY = el.scrollHeight > el.clientHeight + 4 && /(auto|scroll|overlay)/.test(cs.overflowY);
      const canScrollX = el.scrollWidth > el.clientWidth + 16 && /(auto|scroll|overlay)/.test(cs.overflowX);
      if (!canScrollY && !canScrollX) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.45 || rect.height < vh * 0.45) continue;
      if (rect.bottom <= 0 || rect.top >= vh) continue;

      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function collectFixedAndSticky(vw, vh) {
    const fixed = [];
    const sticky = [];
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        return SKIP_TAGS.has(node.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });

    let el = walker.currentNode;
    while (el) {
      const cs = getComputedStyle(el);
      const pos = cs.position;
      if (pos === 'fixed' || pos === 'sticky') {
        if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (pos === 'fixed') {
              if (!(rect.height >= vh * 0.65 && rect.width >= vw * 0.65)) {
                fixed.push({
                  el,
                  isBottom: rect.top > vh * 0.45 && rect.bottom >= vh * 0.5,
                  hidden: false,
                  prevVisibility: el.style.getPropertyValue('visibility'),
                  prevPriority: el.style.getPropertyPriority('visibility'),
                });
              }
            } else if (rect.height < vh * 0.5) {
              sticky.push({
                el,
                topOffset: parseFloat(cs.top),
                bottomOffset: parseFloat(cs.bottom),
                hidden: false,
                prevVisibility: el.style.getPropertyValue('visibility'),
                prevPriority: el.style.getPropertyPriority('visibility'),
              });
            }
          }
        }
      }
      el = walker.nextNode();
    }
    return { fixed, sticky };
  }

  function setVisibilityHidden(item, hide) {
    if (item.hidden === hide) return false;
    item.hidden = hide;
    if (hide) {
      item.el.style.setProperty('visibility', 'hidden', 'important');
    } else if (item.prevVisibility) {
      item.el.style.setProperty('visibility', item.prevVisibility, item.prevPriority);
    } else {
      item.el.style.removeProperty('visibility');
    }
    return true;
  }

  function getPageBackgroundColor() {
    const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : '';
    if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') {
      return bodyBg;
    }
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    if (htmlBg && htmlBg !== 'rgba(0, 0, 0, 0)' && htmlBg !== 'transparent') {
      return htmlBg;
    }
    return '#ffffff';
  }

  function init() {
    if (state) cleanup();

    const style = document.createElement('style');
    style.textContent = `
      html, body, [data-gfp-scroll-target] {
        scroll-behavior: auto !important;
        scroll-snap-type: none !important;
        scrollbar-width: none !important;
      }
      html::-webkit-scrollbar,
      body::-webkit-scrollbar,
      [data-gfp-scroll-target]::-webkit-scrollbar {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    const docEl = document.scrollingElement || document.documentElement;
    // Reading scrollHeight flushes layout synchronously after hiding scrollbars.
    const rootH = Math.max(docEl.scrollHeight, window.innerHeight);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rootW = Math.max(docEl.scrollWidth, vw);

    const docOverflowY = getComputedStyle(docEl).overflowY;
    const bodyOverflowY = document.body ? getComputedStyle(document.body).overflowY : '';
    const rootLocked = docOverflowY === 'hidden' || (bodyOverflowY === 'hidden' && rootH <= vh + 2);

    let mode = 'window';
    let container = null;
    let prevTargetAttr = null;
    if (rootH <= vh + 2 || rootLocked) {
      container = findNestedScrollContainer(vw, vh);
      if (container) {
        mode = 'container';
        prevTargetAttr = container.getAttribute('data-gfp-scroll-target');
        container.setAttribute('data-gfp-scroll-target', '1');
      }
    }

    const origX = window.scrollX;
    const origY = window.scrollY;
    const origContainerX = container ? container.scrollLeft : 0;
    const origContainerY = container ? container.scrollTop : 0;

    let containerRect = null;
    let contentWidth = rootW;
    let contentHeight = rootH;
    let stepWidth = vw;
    let stepHeight = vh;
    let isRtl = getComputedStyle(docEl).direction === 'rtl';

    if (mode === 'container' && container) {
      const r = container.getBoundingClientRect();
      containerRect = {
        left: Math.round(r.left + container.clientLeft),
        top: Math.round(r.top + container.clientTop),
        width: Math.round(container.clientWidth),
        height: Math.round(container.clientHeight),
      };
      contentWidth = container.scrollWidth;
      contentHeight = container.scrollHeight;
      stepWidth = container.clientWidth;
      stepHeight = container.clientHeight;
      isRtl = getComputedStyle(container).direction === 'rtl';
    }

    // Single-row captures keep all overlays visible, so skip walking the DOM.
    const needsMultiRow = contentHeight > stepHeight + 2;
    const { fixed, sticky } = needsMultiRow
      ? collectFixedAndSticky(vw, vh)
      : { fixed: [], sticky: [] };

    state = {
      style,
      mode,
      container,
      containerRect,
      prevTargetAttr,
      origX,
      origY,
      origContainerX,
      origContainerY,
      fixed,
      sticky,
    };

    return {
      mode,
      viewportWidth: vw,
      viewportHeight: vh,
      contentWidth,
      contentHeight,
      stepWidth,
      stepHeight,
      containerRect,
      isRtl,
      title: document.title || '',
      url: location.href,
      backgroundColor: getPageBackgroundColor(),
    };
  }

  async function scrollToStep({ x, y, isFirstRow, isLastRow }) {
    if (!state) {
      throw new Error('Capture not initialized');
    }

    const prevX = state.mode === 'container' && state.container ? state.container.scrollLeft : window.scrollX;
    const prevY = state.mode === 'container' && state.container ? state.container.scrollTop : window.scrollY;

    if (state.mode === 'container' && state.container) {
      state.container.scrollLeft = x;
      state.container.scrollTop = y;
    } else if (prevX !== x || prevY !== y) {
      window.scrollTo(x, y);
    }

    let changed = false;
    for (const item of state.fixed) {
      const shouldShow = item.isBottom ? isLastRow : isFirstRow;
      if (setVisibilityHidden(item, !shouldShow)) changed = true;
    }

    const stickyTopBase = state.containerRect ? state.containerRect.top : 0;
    const stickyBottomBase = state.containerRect
      ? state.containerRect.top + state.containerRect.height
      : window.innerHeight;

    for (const item of state.sticky) {
      if (Number.isFinite(item.topOffset)) {
        if (isFirstRow) {
          if (setVisibilityHidden(item, false)) changed = true;
        } else {
          const rect = item.el.getBoundingClientRect();
          const isStuck = rect.top <= stickyTopBase + item.topOffset + 4 && rect.bottom > stickyTopBase;
          if (setVisibilityHidden(item, isStuck)) changed = true;
        }
      } else if (Number.isFinite(item.bottomOffset)) {
        if (isLastRow) {
          if (setVisibilityHidden(item, false)) changed = true;
        } else {
          const rect = item.el.getBoundingClientRect();
          const isStuck = rect.bottom >= stickyBottomBase - item.bottomOffset - 4 && rect.top < stickyBottomBase;
          if (setVisibilityHidden(item, isStuck)) changed = true;
        }
      }
    }

    const curX = state.mode === 'container' && state.container ? state.container.scrollLeft : window.scrollX;
    const curY = state.mode === 'container' && state.container ? state.container.scrollTop : window.scrollY;

    if (changed || curX !== prevX || curY !== prevY) {
      await nextFrames(2);
    }

    const bottomOverlays = [];
    if (isLastRow && !isFirstRow && state.mode === 'window') {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (const item of state.fixed) {
        if (!item.isBottom || item.hidden) continue;
        const r = item.el.getBoundingClientRect();
        const left = Math.max(0, r.left);
        const top = Math.max(0, r.top);
        const right = Math.min(vw, r.right);
        const bottom = Math.min(vh, r.bottom);
        if (right > left && bottom > top) {
          bottomOverlays.push({
            left,
            top,
            width: right - left,
            height: bottom - top,
          });
        }
      }
    }

    return {
      actualX: state.mode === 'container' && state.container ? state.container.scrollLeft : window.scrollX,
      actualY: state.mode === 'container' && state.container ? state.container.scrollTop : window.scrollY,
      bottomOverlays,
    };
  }

  function cleanup() {
    if (!state) return;

    for (const item of state.fixed) {
      setVisibilityHidden(item, false);
    }
    for (const item of state.sticky) {
      setVisibilityHidden(item, false);
    }
    if (state.container) {
      if (state.prevTargetAttr === null) {
        state.container.removeAttribute('data-gfp-scroll-target');
      } else {
        state.container.setAttribute('data-gfp-scroll-target', state.prevTargetAttr);
      }
      state.container.scrollLeft = state.origContainerX;
      state.container.scrollTop = state.origContainerY;
    }
    window.scrollTo(state.origX, state.origY);
    if (state.style && state.style.parentNode) {
      state.style.parentNode.removeChild(state.style);
    }
    state = null;
  }

  window.__gfpLite = { init, scrollToStep, cleanup };
  return init();
})();
