// 网页翻译助手 - 内容脚本:整页双语翻译 / 划词翻译 / 状态浮条
(() => {
  if (window.__wtAlive) return;
  window.__wtAlive = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH', 'IFRAME', 'OBJECT',
  ]);
  const ENGINE_LABEL = { google: 'Google', bing: '必应', mymemory: 'MyMemory' };
  const MAX_SEGMENTS = 4000; // 超长目录页(kali.org/tools 等)条目多,上限调大

  const state = { translated: false, busy: false, ops: [], total: 0, done: 0, engine: null, notice: '', display: 'both', results: new Map() };

  const send = (msg) => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; resolve(r); });
    } catch { resolve(null); }
  });

  const el = (tag, cls, text) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  };

  // ---------- 状态浮条 ----------
  let pill = null;
  let pillFadeTimer = null;
  function ensurePill() {
    if (!pill || !pill.isConnected) {
      pill = el('div', 'wt-pill');
      document.documentElement.appendChild(pill);
    }
    return pill;
  }
  function hidePill() { if (pill) pill.style.display = 'none'; }
  // 完成后自动淡出:浮条常驻会挡住 GitHub 头像菜单等右上角页面元素
  function schedulePillFade() {
    clearTimeout(pillFadeTimer);
    pillFadeTimer = setTimeout(() => {
      if (!pill) return;
      pill.classList.add('wt-fade');
      pillFadeTimer = setTimeout(hidePill, 500);
    }, 8000);
  }
  function showPill(mode, text) {
    const p = ensurePill();
    clearTimeout(pillFadeTimer);
    p.classList.remove('wt-fade');
    p.style.display = 'flex';
    p.textContent = '';
    const close = el('button', 'wt-close', '✕');
    close.onclick = hidePill;
    if (mode === 'busy') {
      p.append(
        el('span', 'wt-spin'),
        el('span', null, `翻译中 ${state.done}/${state.total}`),
        close
      );
    } else if (mode === 'done') {
      const eng = state.engine ? ' · ' + (ENGINE_LABEL[state.engine] || state.engine) : '';
      p.append(el('span', null, `✓ 已翻译${eng}`));
      const undo = el('button', null, '还原');
      undo.onclick = () => { hidePill(); restorePage(); };
      p.append(undo, close);
      schedulePillFade();
    } else if (mode === 'partial') {
      // 部分失败必须被看见,不自动淡出;重试走 translatePage():
      // 已成功的段由缓存秒回,只重发失败段
      p.append(el('span', null, '⚠ 部分未翻译'));
      const retry = el('button', null, '重试');
      retry.onclick = () => { hidePill(); translatePage(); };
      const undo = el('button', null, '还原');
      undo.onclick = () => { hidePill(); restorePage(); };
      p.append(retry, undo, close);
    } else { // warn / error
      p.append(el('span', null, text || '出错了'));
      if (mode === 'error') {
        const retry = el('button', null, '重试');
        retry.onclick = () => { hidePill(); translatePage(); };
        p.append(retry);
      }
      p.append(close);
    }
    if (state.notice) p.append(el('span', 'wt-pill-meta', state.notice));
  }

  // ---------- 工具 ----------
  function cjkRatio(s) {
    const chars = [...s];
    if (!chars.length) return 0;
    let c = 0;
    for (const ch of chars) {
      if (/[㐀-䶿一-鿿　-〿＀-￯]/.test(ch)) c++;
    }
    return c / chars.length;
  }

  // ---------- 收集正文文本节点(结构上可包裹的,含标点等碎片) ----------
  function collectNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('.wt-pill, .wt-selbox, .wt-dst, .wt-src')) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT; // 纯空白
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const segs = [];
    let n;
    while ((n = walker.nextNode())) {
      segs.push(n);
      if (segs.length >= MAX_SEGMENTS * 2) break;
    }
    return segs;
  }

  // 是否需要翻译(而非仅包裹,用于仅译文模式下干净隐藏)
  function isTranslatable(nodeValue, target) {
    const s = nodeValue.trim();
    if (s.length < 2) return false;
    if (!/\p{L}|\p{N}/u.test(s)) return false; // 纯符号
    if (/^zh/i.test(target) && cjkRatio(nodeValue) > 0.3) return false; // 已是目标语言
    return true;
  }

  // 填充单个片段的译文(已有译文则跳过)
  function fillOp(op, tr) {
    if (!tr || tr === op.text) { op.dst = false; return; } // 译文为空/与原文相同
    if (op.dst) return;
    const d = el('span', 'wt-dst', tr);
    if (op.span.parentNode) op.span.parentNode.insertBefore(d, op.span.nextSibling);
    op.dst = d;
  }

  // ---------- 显示模式:both 双语对照 / dst 仅看译文 ----------
  function applyDisplay(mode) {
    state.display = mode || 'both';
    document.documentElement.classList.toggle('wt-only-dst', state.display === 'dst');
  }

  // 分批发送翻译请求并填充结果(progress 会体现在浮条上)
  // 两批同时在飞:不让网络往返把 CPU 时间浪费在"等上一批回来才发下一批"上
  async function runChunks(list, target, ops, opts = {}) {
    const CHUNK = opts.chunk || 40, INFLIGHT = opts.inflight || 2;
    const batches = [];
    for (let i = 0; i < list.length; i += CHUNK) batches.push(list.slice(i, i + CHUNK));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const part = batches[next++];
        const res = await send({ type: 'translate', texts: part, target });
        if (!res || !res.ok) throw new Error(res?.error || '翻译服务无响应');
        state.engine = res.engine || state.engine;
        if (res.fallbackFrom) {
          state.notice = `${ENGINE_LABEL[res.fallbackFrom] || res.fallbackFrom} 不可用,已自动切换`;
        }
        const got = new Map();
        part.forEach((t, k) => {
          const tr = res.translations[k];
          got.set(t, tr);
          // 译文与原文相同(专有名词原样返回)也算完成,不再误计为失败;真正失败的(空)保留重试机会
          if (tr != null && tr !== '') state.results.set(t, tr);
        });
        state.done += part.length;
        for (const op of ops) {
          if (op.dst || !op.text || !got.has(op.text)) continue;
          fillOp(op, got.get(op.text));
        }
        showPill('busy');
      }
    };
    await Promise.all(Array.from({ length: Math.min(INFLIGHT, batches.length) }, worker));
  }

  // ---------- 整页翻译 ----------
  // 「翻译此页」永远只翻译:连点多次也保持中文(已译段走缓存秒回),回原文只有「还原」一条路
  async function translatePage() {
    if (state.busy) return;
    if (state.ops.length) restorePage(); // 清理上次残留(译文缓存保留,重翻秒回)

    const cfg = await send({ type: 'getSettings' });
    const target = cfg?.settings?.target || 'zh-CN';
    state.target = target;
    applyDisplay(cfg?.settings?.display);

    const all = collectNodes();
    const nodes = all.filter(node => isTranslatable(node.nodeValue, target));
    if (!nodes.length) {
      showPill('warn', '没有找到需要翻译的内容');
      setTimeout(hidePill, 2600);
      return;
    }

    state.busy = true;
    state.translated = false;
    state.total = 0;
    state.done = 0;
    state.engine = null;
    state.notice = '';
    showPill('busy');

    // 包裹原文(含未翻译碎片,仅译文模式下可干净隐藏),译文插在其后
    const ops = [];
    const translatable = new Set(nodes);
    for (const node of all) {
      const parent = node.parentNode;
      if (!parent) continue;
      const span = el('span', 'wt-src');
      parent.insertBefore(span, node);
      span.appendChild(node);
      ops.push({ span, text: translatable.has(node) ? node.nodeValue.trim() : null, dst: null });
    }
    state.ops = ops;

    const uniq = [...new Set(ops.map(o => o.text).filter(Boolean))];

    // 本页译文缓存:还原后重新翻译直接秒回,不发请求
    for (const op of ops) {
      if (op.text && state.results.has(op.text)) fillOp(op, state.results.get(op.text));
    }
    const need = uniq.filter(t => !state.results.has(t));
    // 首屏优先:视口内的文本排最前,先翻眼前看得见的,不用等整页轮到自己
    const visSet = new Set();
    for (const op of ops) {
      if (!op.text || visSet.has(op.text)) continue;
      const r = op.span.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight && (r.width || r.height)) visSet.add(op.text);
    }
    if (visSet.size) need.sort((a, b) => (visSet.has(b) ? 1 : 0) - (visSet.has(a) ? 1 : 0)); // 稳定排序,组内保持文档顺序
    state.total = need.length;
    state.done = 0;

    try {
      await runChunks(need, target, ops);

      // 补翻:超长页面刚开始时浏览器最拥挤,首批请求容易失败,统一再扫一遍(单批在飞,降并发绕限流)
      const missed = uniq.filter(t => !state.results.has(t));
      if (missed.length) {
        state.total += missed.length;
        state.notice = `补翻遗漏片段(${missed.length} 段)`;
        try { await runChunks(missed, target, ops, { inflight: 1 }); } catch (e) { /* 补翻失败不影响整体 */ }
      }

      state.translated = true;
      state.busy = false;
      const stillMissed = uniq.filter(t => !state.results.has(t)).length;
      if (!ops.some(o => o.dst)) {
        showPill('warn', '译文与原文相同,或全部翻译失败');
      } else if (stillMissed) {
        // 如实报告:失败段不再藏在角落小字里(仅看译文模式下它们会显示原文,看起来像"没翻译")
        state.notice = `${stillMissed} 段仍为英文,点「重试」只补翻这些`;
        showPill('partial');
      } else {
        state.notice = '';
        showPill('done');
      }
    } catch (e) {
      state.busy = false;
      showPill('error', '翻译失败:' + (e.message || e));
    }
  }

  function restorePage() {
    for (const op of state.ops) {
      const span = op.span;
      if (span && span.parentNode) {
        if (op.dst && op.dst.parentNode) op.dst.remove();
        while (span.firstChild) span.parentNode.insertBefore(span.firstChild, span);
        span.remove();
      }
    }
    state.ops = [];
    state.translated = false;
    state.busy = false;
    document.documentElement.classList.remove('wt-only-dst');
  }

  // ---------- 动态内容跟进:翻译完成后,新加载的内容自动补翻 ----------
  let incTimer = null;
  const incObserver = new MutationObserver(() => {
    if (!state.translated) return; // 仅在已翻译状态下跟进
    if (incTimer) clearTimeout(incTimer);
    incTimer = setTimeout(incrementalTranslate, 400);
  });

  async function incrementalTranslate() {
    if (!state.translated) return;
    if (state.busy) { incTimer = setTimeout(incrementalTranslate, 800); return; } // 等整页流程结束再试
    const target = state.target || 'zh-CN';
    const nodes = collectNodes().filter(n => isTranslatable(n.nodeValue, target));
    if (!nodes.length) return;

    // 包裹新增节点(缓存命中的直接秒填)
    const ops = [];
    for (const node of nodes) {
      const parent = node.parentNode;
      if (!parent) continue;
      const span = el('span', 'wt-src');
      parent.insertBefore(span, node);
      span.appendChild(node);
      ops.push({ span, text: node.nodeValue.trim(), dst: null });
    }
    state.ops.push(...ops); // 纳入还原名单

    const need = [...new Set(ops
      .map(o => { if (o.text && state.results.has(o.text)) fillOp(o, state.results.get(o.text)); return o.text; })
      .filter(t => t && !state.results.has(t)))];
    if (!need.length) return;

    state.busy = true; // 防重入
    try {
      const CHUNK = 40;
      for (let i = 0; i < need.length; i += CHUNK) {
        const part = need.slice(i, i + CHUNK);
        const res = await send({ type: 'translate', texts: part, target });
        if (!res || !res.ok) break; // 静默失败,不打断浏览
        state.engine = res.engine || state.engine;
        const got = new Map(part.map((t, k) => [t, res.translations[k]]));
        for (const t of part) {
          const tr = got.get(t);
          if (tr != null && tr !== '') state.results.set(t, tr); // 原样返回(专有名词)同样算完成
        }
        for (const op of ops) {
          if (op.dst || !op.text || !got.has(op.text)) continue;
          fillOp(op, got.get(op.text));
        }
      }
    } finally { state.busy = false; }
  }

  incObserver.observe(document.body, { childList: true, subtree: true });

  // ---------- 划词翻译 ----------
  let selBox = null;
  function hideSel() { if (selBox) { selBox.remove(); selBox = null; } }

  function positionSelBox(rect) {
    if (!selBox) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    selBox.style.visibility = 'hidden';
    selBox.style.maxWidth = Math.min(380, vw - 20) + 'px';
    const w = selBox.offsetWidth, h = selBox.offsetHeight;
    let left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), vw - w - 8);
    let top = rect.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, rect.top - h - 8);
    selBox.style.left = left + 'px';
    selBox.style.top = top + 'px';
    selBox.style.visibility = 'visible';
  }

  async function showSelBox(rect, text) {
    hideSel();
    selBox = el('div', 'wt-selbox');
    selBox.append(el('span', 'wt-spin'), el('span', 'wt-loading', ' 翻译中'));
    document.documentElement.appendChild(selBox);
    positionSelBox(rect);

    const res = await send({ type: 'translate', texts: [text] });
    if (!selBox) return; // 期间被关闭
    selBox.textContent = '';
    selBox.append(el('div', 'wt-sel-src', text.length > 80 ? text.slice(0, 80) + '…' : text));
    const tr0 = res && res.ok ? res.translations[0] : null;
    if (tr0 != null && tr0 !== '') {
      selBox.append(el('div', 'wt-sel-tr', tr0));
      selBox.append(el('div', 'wt-sel-meta', (ENGINE_LABEL[res.engine] || res.engine || '') + ' · 划词翻译'));
    } else {
      selBox.append(el('div', 'wt-sel-tr', '翻译失败:' + (res?.error || '服务无响应')));
    }
    positionSelBox(rect);
  }

  function selectionPopup() {
    if (selBox) return;
    const ae = document.activeElement;
    let text = '', rect = null;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const t = String(sel).trim();
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (t && (r.width || r.height || r.top || r.left)) { text = t; rect = r; }
    }
    // 输入框内的选中
    if ((!text || !rect) && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
        && ae.selectionStart != null && ae.selectionEnd > ae.selectionStart) {
      text = ae.value.slice(ae.selectionStart, ae.selectionEnd).trim();
      rect = ae.getBoundingClientRect();
    }
    if (!text || !rect || text.length > 1200) return;
    showSelBox(rect, text);
  }

  document.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t && t.closest && t.closest('.wt-selbox, .wt-pill, a, button')) return;
    setTimeout(() => selectionPopup(), 50);
  }, true);
  document.addEventListener('mousedown', e => {
    const t = e.target;
    if (!selBox || (t && t.closest && t.closest('.wt-selbox'))) return;
    hideSel();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideSel(); }, true);
  window.addEventListener('scroll', () => hideSel(), { passive: true });

  // ---------- 自动翻译:该网站被标记过则页面加载后自动翻译 ----------
  chrome.storage.sync.get({ autoSites: [] }).then(({ autoSites }) => {
    if (Array.isArray(autoSites) && autoSites.includes(location.hostname)) {
      setTimeout(() => translatePage(), 600); // 稍等片刻让页面内容稳定
    }
  }).catch(() => {});

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'translatePage') { translatePage(); sendResponse({ ok: true }); }
    else if (msg?.type === 'restorePage') { restorePage(); hidePill(); sendResponse({ ok: true }); }
    else if (msg?.type === 'translateSelection') { selectionPopup(); sendResponse({ ok: true }); }
    else if (msg?.type === 'setDisplay') { applyDisplay(msg.display); sendResponse({ ok: true }); }
    else if (msg?.type === 'getStatus') {
      sendResponse({
        ok: true,
        host: location.hostname,
        translated: state.translated, busy: state.busy,
        done: state.done, total: state.total, engine: state.engine, notice: state.notice,
      });
    }
    return false;
  });
})();
