// 网页翻译助手 - 弹窗逻辑
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get({ engine: 'auto', target: 'zh-CN', display: 'both' }).then(s => {
  $('engine').value = s.engine;
  // 目标语言已固定为简体中文:存储里若残留旧值(en/ja/zh-TW)一律纠正
  if (s.target !== 'zh-CN') chrome.storage.sync.set({ target: 'zh-CN' });
  $('display').value = s.display;
});
$('engine').addEventListener('change', () => chrome.storage.sync.set({ engine: $('engine').value }));
$('display').addEventListener('change', async () => {
  const display = $('display').value;
  chrome.storage.sync.set({ display });
  const t = await activeTab();
  if (t?.id) chrome.tabs.sendMessage(t.id, { type: 'setDisplay', display }).catch(() => {});
});

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
function hint(msg) { $('hint').textContent = msg; }

async function page(action) {
  const t = await activeTab();
  if (!t?.id) { hint('找不到当前标签页'); return null; }
  try {
    return await chrome.tabs.sendMessage(t.id, { type: action });
  } catch {
    hint('此页面无法翻译(浏览器内部页面 / 商店页)');
    return null;
  }
}

$('go').addEventListener('click', async () => {
  await page('translatePage');
  setTimeout(() => window.close(), 120);
});
$('undo').addEventListener('click', async () => {
  await page('restorePage');
  setTimeout(() => window.close(), 120);
});

// 打开时显示当前页面状态 + 自动翻译开关
(async () => {
  const t = await activeTab();
  if (!t?.id) return;
  let s = null;
  try { s = await chrome.tabs.sendMessage(t.id, { type: 'getStatus' }); } catch {}
  if (s?.ok) {
    if (s.busy) hint(`翻译中 ${s.done}/${s.total}…`);
    else if (s.translated) hint(`本页已翻译 · 点「还原」可恢复原文`);
    if (s.notice) hint(s.notice);
    if (s.host) {
      const { autoSites = [] } = await chrome.storage.sync.get({ autoSites: [] });
      $('auto').checked = autoSites.includes(s.host);
      $('auto').addEventListener('change', async () => {
        const { autoSites: list = [] } = await chrome.storage.sync.get({ autoSites: [] });
        const next = $('auto').checked
          ? [...new Set([...list, s.host])]
          : list.filter(h => h !== s.host);
        await chrome.storage.sync.set({ autoSites: next });
        if ($('auto').checked) {
          chrome.tabs.sendMessage(t.id, { type: 'translatePage' }).catch(() => {});
          hint('已开启:此网站今后打开即自动翻译');
        }
      });
    }
  } else {
    $('auto').disabled = true;
    hint('此页面可能不支持(浏览器内部页面)');
  }
})();
