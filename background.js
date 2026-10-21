// 网页翻译助手 - 后台服务:引擎调度 / 缓存 / 消息中枢
// 所有网络请求都在这里发出(内容脚本受页面 CORS 限制)

const DEFAULT_SETTINGS = { engine: 'auto', target: 'zh-CN', display: 'both' };
const ENGINE_LABEL = { google: 'Google', bing: '必应', mymemory: 'MyMemory' };
const BING_TARGET = { 'zh-CN': 'zh-Hans' }; // 目标语言已固定为简体中文

let settings = { ...DEFAULT_SETTINGS };
// 引擎临时不可用截止时间戳(DOWN 2 分钟 / QUOTA 6 小时,过期自动重探——网络环境随时可能变化)
const downUntil = { google: 0, bing: 0, mymemory: 0 };
// auto 模式最近跑通的引擎:5 分钟内直接复用,免去每批都并发竞速
const PREFERRED_TTL = 5 * 60 * 1000;
let preferred = null; // { eng, at }

function markDown(eng, e) {
  if (e?.code === 'DOWN') downUntil[eng] = Date.now() + 2 * 60 * 1000;
  else if (e?.code === 'QUOTA') downUntil[eng] = Date.now() + 6 * 60 * 60 * 1000;
}

// ---------- 设置 ----------
async function loadSettings() {
  const got = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = { ...DEFAULT_SETTINGS, ...got };
}
chrome.storage.onChanged.addListener(() => loadSettings());
loadSettings();

// ---------- 翻译缓存(跨引擎共享:目标语言+原文 → 译文) ----------
const cache = new Map();
const ckey = (target, text) => JSON.stringify([target, text]);

// 会话级持久化:后台进程被浏览器休眠重启后缓存不丢(浏览器关闭才清空)
const CACHE_KEY = 'wtCache';
loadCacheFromSession();
let cacheSaveTimer = null;
function loadCacheFromSession() {
  chrome.storage.session.get(CACHE_KEY).then(({ wtCache }) => {
    if (Array.isArray(wtCache)) for (const [k, v] of wtCache) cache.set(k, v);
  }).catch(() => {});
}
function scheduleCacheSave() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    // 序列化最新 4000 条(约几 MB,在会话存储限额内)
    chrome.storage.session.set({ wtCache: [...cache.entries()].slice(-4000) }).catch(() => {});
  }, 2000);
}

function errCode(message, code) {
  const e = new Error(message);
  e.code = code; // 'DOWN' 临时不可用可降级 | 'QUOTA' 额度耗尽 | 'FATAL' 明确失败
  return e;
}

// ---------- 并发池:worker 抛错只记录,单项失败保留原文 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function runPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const errs = [];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        try { out[i] = await worker(items[i], i); } catch (e) { errs.push(e); }
      }
    })
  );
  if (items.length && errs.length === items.length) throw errs[0]; // 全军覆没才换引擎
  return out;
}

// ---------- Google(首选 clients5 批量端点,失败换 gtx 逐段端点;需代理) ----------
async function googleClients5(texts, target) {
  // 按 URL 长度分块,每块携带多个 q 参数(实测返回按序对齐的数组)
  const chunks = [];
  let cur = [], curIdx = 0, len = 0, base = 0;
  for (let i = 0; i < texts.length; i++) {
    const enc = encodeURIComponent(texts[i]).length + 3;
    if (cur.length && (len + enc > 1800 || cur.length >= 25)) {
      chunks.push({ texts: cur, base });
      base = i; cur = []; len = 0;
    }
    cur.push(texts[i]); len += enc;
  }
  if (cur.length) chunks.push({ texts: cur, base });

  const out = new Array(texts.length);
  await runPool(chunks, 4, async ({ texts: chunk, base: b }) => {
    const u = new URL('https://clients5.google.com/translate_a/t');
    u.searchParams.set('client', 'dict-chrome-ex');
    u.searchParams.set('sl', 'auto');
    u.searchParams.set('tl', target);
    for (const t of chunk) u.searchParams.append('q', t);
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw errCode('google http ' + r.status, r.status === 429 || r.status >= 500 ? 'DOWN' : 'FATAL');
    const j = await r.json().catch(() => null);
    // 共享代理出口被 Google 反爬拦截时会返回 "Sorry..." HTML(HTTP 200),按引擎不可用降级而非裸异常
    if (!Array.isArray(j) || j.length !== chunk.length) throw errCode('google 响应异常/反爬拦截', 'DOWN');
    j.forEach((x, k) => {
      const tr = Array.isArray(x) ? x[0] : x;
      out[b + k] = typeof tr === 'string' && tr ? tr : chunk[k];
    });
  });
  return out;
}

// gtx 备用端点:共享代理 IP 触发 clients5 限流(429)时往往仍可用;单段 POST 避免 URL 长度限制
async function gtxOne(text, target) {
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sl: 'auto', tl: target, q: text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw errCode('google http ' + r.status, r.status === 429 || r.status >= 500 ? 'DOWN' : 'FATAL');
  const j = await r.json().catch(() => null);
  // 出口 IP 被反爬拦截时返回 "Sorry..." HTML(HTTP 200):按 DOWN 降级,
  // 不能让裸 SyntaxError 漏出去(无 code → markDown 不生效 → 引擎不被拉黑反复撞墙)
  if (!j || !Array.isArray(j[0])) throw errCode('google 反爬拦截(gtx)', 'DOWN');
  const tr = j[0].map(s => s?.[0] || '').join('');
  return tr || text;
}

async function googleBatch(texts, target) {
  try {
    return await googleClients5(texts, target);
  } catch (e) {
    if (e.code === 'FATAL') throw e;
    return runPool(texts, 6, t => gtxOne(t, target));
  }
}

// ---------- 必应(国内直连走 cn,代理出口下 cn 会话易失效自动换 www;翻译质量最好) ----------
let bingSession = null;
let bingHostIdx = 0; // 上次成功的域名粘住,减少试探
let bingFailUntil = 0; // 会话连续失败熔断:批内后续请求快速失败,15 秒后自动重试
const BING_HOSTS = ['cn.bing.com', 'www.bing.com'];

async function bingEnsureSession() {
  if (bingSession && Date.now() < bingSession.expireAt) return bingSession;
  if (Date.now() < bingFailUntil) throw errCode('必应暂不可用', 'DOWN');
  let lastErr = null;
  for (let h = 0; h < BING_HOSTS.length; h++) {
    const host = BING_HOSTS[(bingHostIdx + h) % BING_HOSTS.length];
    try {
      const r = await fetch(`https://${host}/translator`, {
        credentials: 'include',
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw errCode('必应 http ' + r.status, 'DOWN');
      const page = await r.text();
      const ig = page.match(/IG:"([^"]+)"/)?.[1];
      const iid = page.match(/data-iid="([^"]+)"/)?.[1];
      const m = page.match(/params_AbusePreventionHelper\s?=\s?([^\]]+\])/);
      if (!ig || !iid || !m) throw errCode('必应会话解析失败', 'DOWN');
      const [key, token, ttl] = JSON.parse(m[1]);
      // 以重定向后的真实域为准(国内网络 www 会 302 到 cn):POST 必须同域,否则 cookie 失效 401
      const final = new URL(r.url);
      bingHostIdx = Math.max(0, BING_HOSTS.indexOf(final.hostname));
      bingSession = { origin: final.origin, ig, iid, key, token, expireAt: Date.now() + Number(ttl || 3600000) - 60000 };
      return bingSession;
    } catch (e) { lastErr = e; bingSession = null; }
  }
  bingFailUntil = Date.now() + 15000;
  throw lastErr;
}

async function bingPost(text, target, retried = false) {
  const s = await bingEnsureSession();
  const r = await fetch(
    `${s.origin}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(s.ig)}&IID=${encodeURIComponent(s.iid)}`,
    {
      method: 'POST',
      credentials: 'include',
      referrer: s.origin + '/translator', // 模拟从翻译页发出,降低反爬拦截率
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        fromLang: 'auto-detect',
        to: BING_TARGET[target] || target,
        text,
        token: s.token,
        key: String(s.key),
        tryFetchingGenderDebiasedTranslations: true, // 缺此字段会 401
      }),
      signal: AbortSignal.timeout(10000),
    }
  );
  const j = r.status === 401 ? null : await r.json().catch(() => null);
  const out = j?.[0]?.translations?.[0]?.text;
  if (typeof out !== 'string') {
    bingSession = null;
    if (!retried) {
      bingHostIdx = (bingHostIdx + 1) % BING_HOSTS.length; // 当前域可能被代理出口干扰,换域重建会话再试一次
      return bingPost(text, target, true);
    }
    throw errCode('必应限流或会话失效', 'DOWN');
  }
  return out;
}

// 必应免费端点一次只收一段:短段拼成"编号多行"一次请求(实测 LLM 翻译保持编号结构,30 段快 ~4.6 倍),
// 拆回时校验条数与行号,拆不齐就整包逐段重来,保证译文绝不错位上屏
const BING_PACK_CHARS = 800, BING_PACK_LINES = 12;

function bingUnpack(out, count) {
  const lines = String(out).split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length !== count) return null;
  const parts = [];
  for (let k = 0; k < lines.length; k++) {
    // 行号必须严格等于序号(数字后跟标点或空格),任何含糊都判拆分失败
    const m = lines[k].match(/^(\d+)(?:[.、．:：]|\s)\s*(.*)$/);
    if (!m || Number(m[1]) !== k + 1) return null;
    parts.push(m[2] || '');
  }
  return parts;
}

async function bingBatch(texts, target) {
  // 打包:无换行且 ≤300 字的段按字符预算组包;长段/含换行段单独成包(不编号)
  const jobs = [];
  let idxs = [], parts = [], len = 0;
  const flush = () => {
    if (idxs.length) jobs.push({ idxs, text: parts.map((t, k) => `${k + 1}. ${t}`).join('\n'), numbered: true });
    idxs = []; parts = []; len = 0;
  };
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (t.includes('\n') || t.length > 300) { jobs.push({ idxs: [i], text: t, numbered: false }); continue; }
    if (parts.length && (len + t.length > BING_PACK_CHARS || parts.length >= BING_PACK_LINES)) flush();
    parts.push(t); len += t.length; idxs.push(i);
  }
  flush();

  const out = new Array(texts.length).fill(null);
  // 并发 2 + 每发错峰:必应防滥用 token 对密集请求极敏感(实测连续数发即 400 全拒),
  // 前台两批在飞 × 2 = 4 个在途请求,并在每发前留随机间隔,大幅减少会话被打废的频率
  await runPool(jobs, 2, async job => {
    await sleep(200 + Math.random() * 200); // 错峰,避免齐射
    const raw = await bingPost(job.text, target); // 失败(限流等)交上层重试机制
    let res = job.numbered ? bingUnpack(raw, job.idxs.length) : [raw];
    if (!res) {
      // 请求成功但拆分不齐(引擎吞了行号/并了行):整包逐段重来,保证译文不错位
      res = [];
      for (const oi of job.idxs) res.push(await bingPost(texts[oi], target));
    }
    job.idxs.forEach((oi, k) => { out[oi] = res[k]; });
  });
  return out;
}

// ---------- MyMemory(免代理,免密钥,每日约 5000 字额度,仅兜底) ----------
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// 超过单次 500 字上限的段落:按句子边界切小段翻完再拼回,不再截断
function splitText(text, max = 450) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?。！？；;\n])/)) {
    if (s.length > max) {
      if (cur) { parts.push(cur); cur = ''; }
      for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
    } else if ((cur + s).length > max) { parts.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) parts.push(cur);
  return parts;
}

async function mmPart(text, target) {
  const u = new URL('https://api.mymemory.translated.net/get');
  u.searchParams.set('q', text);
  u.searchParams.set('langpair', 'Autodetect|' + target);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw errCode('mymemory http ' + r.status, r.status >= 500 ? 'DOWN' : 'FATAL');
  const j = await r.json();
  const t = j?.responseData?.translatedText ?? '';
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) throw errCode('MyMemory 今日免费额度已用完', 'QUOTA');
  if (/INVALID (SOURCE|TARGET|LANGUAGE)/i.test(t)) throw errCode('MyMemory 不支持该语言对', 'FATAL');
  if (/PLEASE SELECT TWO DISTINCT/i.test(t)) return text; // 原文已是目标语言
  return decodeEntities(t) || text;
}

async function mmOne(text, target) {
  const parts = splitText(text);
  if (parts.length === 1) return mmPart(text, target);
  const out = [];
  for (const p of parts) out.push(await mmPart(p, target));
  return out.join('');
}

async function mmBatch(texts, target) {
  return runPool(texts, 4, t => mmOne(t, target));
}

// ---------- 引擎调度:auto = 竞速自适应(代理开/关、节点切换后自动重新选路) ----------
const BATCH_FN = { google: googleBatch, bing: bingBatch, mymemory: mmBatch };
function engineChain(name) {
  if (name === 'google') return ['google', 'mymemory'];
  if (name === 'bing') return ['bing', 'mymemory'];
  if (name === 'mymemory') return ['mymemory'];
  return ['google', 'bing', 'mymemory'];
}

// 单引擎跑一批(含单项失败的补翻重试)
async function tryEngine(eng, pending, target) {
  let res = await BATCH_FN[eng](pending, target);
  const missed = pending.filter((t, i) => res[i] == null);
  if (missed.length && missed.length < pending.length) {
    const retry = await BATCH_FN[eng](missed, target).catch(() => null);
    if (retry) {
      const rm = new Map(missed.map((t, i) => [t, retry[i] ?? t]));
      res = pending.map((t, i) => res[i] ?? rm.get(t));
    }
  }
  return res;
}

async function translateTexts(texts, engineName, target) {
  const uniq = [...new Set(texts.filter(t => typeof t === 'string' && t.trim()))];
  const tr = new Map();
  const pending = [];
  for (const t of uniq) {
    const hit = cache.get(ckey(target, t));
    if (hit != null) tr.set(t, hit); else pending.push(t);
  }

  const chain = engineChain(engineName || settings.engine);
  let used = null, fallbackFrom = null, err = null, res = null;
  if (!pending.length) {
    return { translations: texts.map(t => tr.get(t) ?? t), engine: chain[0], fallbackFrom: null };
  }

  const now = Date.now();
  let avail = chain.filter(e => now >= downUntil[e]);
  if (!avail.length) avail = [...chain]; // 全部被标记:网络环境可能已变(如代理刚开/关),全部重探

  // 1) 优选引擎:近 5 分钟跑通过的直接单跑,省去并发开销
  if (preferred && avail.includes(preferred.eng) && Date.now() - preferred.at < PREFERRED_TTL) {
    const eng = preferred.eng;
    try {
      res = await tryEngine(eng, pending, target);
      used = eng;
    } catch (e) { err = e; markDown(eng, e); }
  }
  // 2) 竞速:主力引擎同时发请求,谁先成功用谁——代理开着 Google 快、代理关着必应通,无需探测网络状态
  if (!used) {
    const racers = avail.filter(e => e !== 'mymemory'); // 兜底引擎有每日额度,不参与竞速
    await new Promise(resolve => {
      let alive = racers.length;
      if (!alive) return resolve();
      for (const eng of racers) {
        tryEngine(eng, pending, target).then(r => {
          if (!used) { used = eng; res = r; resolve(); }
        }).catch(e => { err = e; markDown(eng, e); if (--alive === 0) resolve(); });
      }
    });
  }
  // 3) 串行兜底:MyMemory 等
  if (!used) {
    for (const eng of avail) {
      if (downUntil[eng] > Date.now()) continue;
      try {
        res = await tryEngine(eng, pending, target);
        used = eng;
        break;
      } catch (e) { err = e; markDown(eng, e); }
    }
  }

  if (!used) throw err || errCode('所有翻译引擎均不可用', 'FATAL');

  preferred = { eng: used, at: Date.now() };
  if (used !== chain[0]) fallbackFrom = chain[0];
  pending.forEach((t, i) => {
    const v = res[i];
    if (v == null || v === '') return; // 失败项回传 null(与"专有名词原样返回"区分开),前台会重试
    tr.set(t, v);
    if (v !== t) cache.set(ckey(target, t), v); // 原样返回的不占缓存;失败项不进缓存,保留重试机会
  });
  scheduleCacheSave();
  if (cache.size > 8000) {
    const it = cache.keys();
    for (let k = 0; k < 4000; k++) cache.delete(it.next().value);
  }
  return { translations: texts.map(t => tr.get(t) ?? null), engine: used, fallbackFrom };
}

// ---------- 消息中枢 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'translate') {
        const r = await translateTexts(msg.texts, msg.engine, msg.target || settings.target);
        sendResponse({ ok: true, ...r });
      } else if (msg?.type === 'getSettings') {
        sendResponse({ ok: true, settings, downUntil: { ...downUntil } });
      } else {
        sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e), code: e.code });
    }
  })();
  return true; // 异步回复
});

// ---------- 右键菜单:翻译选中文字 ----------
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: 'wt-sel', title: '翻译选中文字「%s」', contexts: ['selection'] });
  } catch (e) { /* 扩展重载导致菜单已存在时忽略 */ }
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'wt-sel' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'translateSelection' }).catch(() => {});
  }
});
