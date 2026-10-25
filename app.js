import { nextBox, isMastered, scoreExam, progressStats, wrongQuestionIds, toMarkdown, toNotionMarkdown, buildNotionPagePayload, cardToNotionMarkdown, calcNextReview, formatReviewDue, reviewPriority, guessLevel, nextExam, MASTER_BOX, parseExplanationOptions, diagnoseStudentAnswer, mergeStores } from './core.js';

const STORE_KEY = 'ipas_quiz_progress';
// 部署 Cloudflare Worker 後填入，例如 'https://ipas-quiz-sync.你的帳號.workers.dev'。留空=只用本機。
const SYNC_URL = 'https://ipas-quiz-sync.yazelinj303.workers.dev';
const VAPID_PUBLIC = 'BNn4Lwq818aHx8cb0LrcQ6IpRgHb9B3P_BOqusct-uFyJPQ4hlDrIOirliHoNdbbg5tg8zWfzBg5SZ0yBhRq7zA';
const $ = (sel) => document.querySelector(sel);
const view = $('#view');

let DATA = { meta: {}, questions: [] };
let CONCEPTS = [];
let GUIDE_DATA = { categories: [], cards: [] };
let EXAMINFO = null;
let store = load();
let pushTimer = null;
let dirty = false; // 有未上傳的本機變動才寫 KV(localStorage 才是本機真相,KV 只跨裝置)
let activeMockTimer = null;
let activeMockSessionSaver = null;

function clearMockTimer() {
  if (activeMockSessionSaver) {
    try { activeMockSessionSaver(); } catch {}
    activeMockSessionSaver = null;
  }
  if (activeMockTimer) {
    clearInterval(activeMockTimer);
    activeMockTimer = null;
  }
}

// PWA 安裝：接管 beforeinstallprompt，顯示自家「安裝」按鈕（Android/桌面 Chrome）
// 用單機旗標記住「已關掉/已安裝」就別再顯示（install 狀態每台不同，故不進同步 store）
let deferredInstall = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const installBarOff = () => localStorage.getItem('ipas_installbar_off') === '1';
const dismissInstallBar = () => { localStorage.setItem('ipas_installbar_off', '1'); const b = document.getElementById('installbar'); if (b) b.hidden = true; deferredInstall = null; };
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const bar = document.getElementById('installbar');
  if (bar && !isStandalone() && !installBarOff()) bar.hidden = false;
});
window.addEventListener('appinstalled', dismissInstallBar);

// ---- localStorage ----
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.q) {
      s.cards ||= {};
      // 安全遷移：將舊版留在 store.settings 的 Notion 金鑰轉移至本機 localStorage 並從 store 抹除
      if (s.settings?.notionToken) {
        if (!localStorage.getItem('ipas_notion_token')) localStorage.setItem('ipas_notion_token', s.settings.notionToken);
        delete s.settings.notionToken;
      }
      if (s.settings?.notionDbId) {
        if (!localStorage.getItem('ipas_notion_db_id')) localStorage.setItem('ipas_notion_db_id', s.settings.notionDbId);
        delete s.settings.notionDbId;
      }
      if (s.settings?.notionProxy) {
        if (!localStorage.getItem('ipas_notion_proxy')) localStorage.setItem('ipas_notion_proxy', s.settings.notionProxy);
        delete s.settings.notionProxy;
      }
      return s;
    }
  } catch {}
  return { v: 1, syncCode: makeCode(), codeFresh: true, q: {}, cards: {}, recent: [], updatedAt: 0 };
}

// 艾賓浩斯遺忘曲線到期檢索
function getDueQuestions() {
  const now = Date.now();
  return DATA.questions.filter((q) => {
    const p = store.q[q.id];
    return p && p.reviewDue && p.reviewDue <= now;
  });
}

function getDueCards() {
  const now = Date.now();
  return (GUIDE_DATA.cards || []).filter((c) => {
    const s = store.cards?.[c.id];
    return s && s.reviewDue && s.reviewDue <= now;
  });
}

// 記一筆最近作答結果(1/0)，保留最近 50 筆，供「近期正確率」
function logRecent(correct) {
  (store.recent ||= []).push(correct ? 1 : 0);
  if (store.recent.length > 50) store.recent = store.recent.slice(-50);
}

// ---- 推播提醒(Web Push)----
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function urlB64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function pushIsOn() {
  if (!pushSupported() || !SYNC_URL) return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}
async function enablePush(localHour) {
  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: '未允許通知權限' };
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID_PUBLIC) });
  const offsetMin = new Date().getTimezoneOffset();
  let utcMin = (localHour * 60 + offsetMin) % 1440; if (utcMin < 0) utcMin += 1440;
  const r = await fetch(`${SYNC_URL}/push/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: store.syncCode, subscription: sub.toJSON(), hourUtc: Math.floor(utcMin / 60), offsetMin }),
  });
  return { ok: r.ok };
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  await fetch(`${SYNC_URL}/push/unsubscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: store.syncCode }),
  }).catch(() => {});
}

// ---- 每日目標 / 連續打卡 / 考前倒數 ----
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); };
const dailyGoal = () => (store.settings && store.settings.dailyGoal) || 20;
const todayCount = () => {
  const t = today();
  const dCount = (store.daily && store.daily.date === t) ? (store.daily.count || 0) : 0;
  const hCount = (store.history && store.history[t] && store.history[t].a) ? store.history[t].a : 0;
  return Math.max(dCount, hCount);
};
// 顯示用的連續天數：最後達標日是今天或昨天才還活著，否則歸 0
function liveStreak() {
  const s = store.streak; if (!s || !s.lastDate) return 0;
  return (s.lastDate === today() || s.lastDate === yesterday()) ? s.count : 0;
}
// 準備級別偏好：設定過優先；未設定則自動猜測，猜不出預設「初級」
function prefLevel() {
  return (store.settings && store.settings.prefLevel) || guessLevel(store.q || {}) || '初級';
}
// 倒數要對準哪一場。自己在設定裡填過的一律優先;沒填就依目標級別/練過的題自動對準
function examTarget() {
  const set = store.settings && store.settings.examDate;
  if (set) return { date: set, level: null };
  if (!EXAMINFO) return null;
  const pref = prefLevel();
  return nextExam(EXAMINFO.exams, today(), (pref && pref !== '全部') ? pref : null);
}
function daysUntilExam() {
  const t = examTarget(); if (!t) return null;
  return Math.ceil((new Date(t.date + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
}
// 每答一題呼叫：累加今日題數、記每日歷史、達標當下更新打卡
function bumpDaily(correct) {
  const t = today();
  store.settings ||= { dailyGoal: 20, examDate: '' };
  if (!store.daily || store.daily.date !== t) store.daily = { date: t, count: 0 };
  store.daily.count++;
  // 每日歷史（答題數/答對數），保留最近 30 天
  store.history ||= {};
  const h = (store.history[t] ||= { a: 0, c: 0 });
  h.a++; if (correct) h.c++;
  const days = Object.keys(store.history).sort();
  if (days.length > 30) delete store.history[days[0]];
  store.streak ||= { count: 0, lastDate: '' };
  if (store.daily.count === dailyGoal() && store.streak.lastDate !== t) {
    store.streak = { count: (store.streak.lastDate === yesterday() ? store.streak.count : 0) + 1, lastDate: t };
  }
}
function save() {
  store.updatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
  dirty = true;
  saveLocalDisk();
  schedulePush();
}

// 本機硬碟自動備份 (server.mjs /local-progress)，即使清除瀏覽器快取或強制重整也不會丟失每日紀錄與題庫進度
function isLocalServer() {
  return typeof window !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

async function saveLocalDisk() {
  if (!isLocalServer()) return;
  try {
    const payload = structuredClone(store);
    if (payload.settings) {
      delete payload.settings.notionToken;
      delete payload.settings.notionDbId;
      delete payload.settings.notionProxy;
    }
    await fetch('/local-progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {}
}

// mergeStores 已固化至 core.js 並導入，確保具備完整單元測試覆蓋

async function pullLocalDisk() {
  if (!isLocalServer()) return false;
  try {
    const r = await fetch('/local-progress');
    if (!r.ok) {
      // 如果硬碟還沒有備份檔，且目前瀏覽器有資料，立刻寫入硬碟建立初始備份
      if (Object.keys(store.q || {}).length > 0 || (store.daily && store.daily.count > 0)) {
        await saveLocalDisk();
      }
      return false;
    }
    const diskStore = await r.json();
    if (diskStore && diskStore.q) {
      store = mergeStores(store, diskStore);
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      await saveLocalDisk();
      return true;
    }
  } catch {}
  return false;
}

// ---- 雲端同步（同步碼，免帳號） ----
// 寫入策略:checkpoint(交卷/練習完成/切走關頁)立即 flush;持續作答只在停頓 30s 後補寫一次。
// dirty gating = 沒變動就絕不寫,省 KV 寫入額度。
function schedulePush() {
  if (!SYNC_URL) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushSync, 30000); // ponytail: debounce 30s 只當長 session 的保底;真正的寫在 checkpoint
}
async function pushSync(opts = {}) {
  clearTimeout(pushTimer); pushTimer = null;
  if (!SYNC_URL || !store.syncCode) return false;
  if (!dirty) return true; // 沒有未上傳的變動就不寫 KV
  try {
    // 嚴防機敏外洩：過濾 Notion Integration Token 等本機專屬金鑰
    const payload = structuredClone(store);
    if (payload.settings) {
      delete payload.settings.notionToken;
      delete payload.settings.notionDbId;
      delete payload.settings.notionProxy;
    }
    const r = await fetch(`${SYNC_URL}/sync/${encodeURIComponent(store.syncCode)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      keepalive: opts.keepalive || false, // 關頁/切走時讓請求活過頁面卸載
    });
    if (r.ok) dirty = false;
    return r.ok;
  } catch { return false; }
}
async function pullSync() {
  if (!SYNC_URL || !store.syncCode) return false;
  try {
    const r = await fetch(`${SYNC_URL}/sync/${encodeURIComponent(store.syncCode)}`);
    if (!r.ok) return false;
    const remote = await r.json();
    if (remote && remote.q) {
      store = mergeStores(store, remote);
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      saveLocalDisk();
      return true;
    }
  } catch {}
  return false;
}
function qp(id) {
  return (store.q[id] ||= { box: 1, attempts: 0, correct: 0, wrong: 0, note: '', studentAnswer: '', starred: false, lastAnsweredAt: 0, updatedAt: 0, noteUpdatedAt: 0, starredUpdatedAt: 0, reviewUpdatedAt: 0 });
}
// 碼空間 40×40×9000 = 1,440 萬(舊版 10×10×90=9,000,估計已撞出上百對共用碼)
function makeCode() {
  const a = ['fox', 'owl', 'koi', 'elm', 'jade', 'mint', 'sage', 'wren', 'lark', 'reef',
    'ash', 'birch', 'cedar', 'crane', 'deer', 'dove', 'fern', 'finch', 'gull', 'hare',
    'hawk', 'ibis', 'iris', 'kelp', 'kiwi', 'lily', 'lotus', 'lynx', 'mole', 'moss',
    'moth', 'newt', 'orca', 'pine', 'plum', 'quail', 'seal', 'swan', 'teal', 'wolf'];
  const b = ['river', 'cloud', 'stone', 'ember', 'tide', 'grove', 'dune', 'frost', 'maple', 'comet',
    'breeze', 'brook', 'canyon', 'cave', 'cliff', 'coast', 'coral', 'creek', 'delta', 'fjord',
    'gale', 'glade', 'gorge', 'harbor', 'inlet', 'lagoon', 'ledge', 'marsh', 'mesa', 'mist',
    'oasis', 'peak', 'pond', 'rain', 'ridge', 'shore', 'sky', 'snow', 'storm', 'vale'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(a)}-${pick(b)}-${Math.floor(1000 + Math.random() * 9000)}`;
}
// 自動產生的新碼先跟雲端查重再定案(雙保險):只碰 codeFresh 的全新 store,
// 手動輸入的碼與既有使用者一律不動。離線或伺服器出錯就放行,不擋使用者。
async function ensureFreshCode() {
  if (!store.codeFresh) return;
  if (SYNC_URL && !store.updatedAt && !Object.keys(store.q || {}).length) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${SYNC_URL}/sync/${encodeURIComponent(store.syncCode)}`);
        if (!r.ok) break; // 404 = 沒人用,定案;5xx 也放行
        store.syncCode = makeCode(); // 被占用 → 重抽再查
      } catch { break; }
    }
  }
  delete store.codeFresh;
  localStorage.setItem(STORE_KEY, JSON.stringify(store)); // 只落地碼,不動 updatedAt
}

// ---- helpers ----
const subjects = () => [...new Set(DATA.questions.map((q) => q.subject))];
const papers = () => [...new Set(DATA.questions.map((q) => `${q.level}｜${q.round}｜${q.subject}`))];
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// 解析顯示用:在「。/；後面的 (A)-(D) 選項分析」與「記憶點」前斷行並加粗,把長段落變條列(不動資料)
function formatExp(text) {
  return esc(text)
    .replace(/([。；])\s*([(（][A-DＡ-Ｄ][)）])/g, '$1<br>$2')
    .replace(/([。；])\s*(核心記憶點|記憶點)/g, '$1<br>$2')
    .replace(/(^|<br>)\s*(正解\s*[(（][A-DＡ-Ｄ][)）]|[(（][A-DＡ-Ｄ][)）]|核心記憶點|記憶點)/g, '$1<strong>$2</strong>');
}
// 教材對應：指到該題所屬科目的評鑑主題 (L111~L234) 與評鑑內容 (L11101~L23402) + 開啟官方 PDF
function guideLine(q) {
  const url = DATA.meta && DATA.meta.guides && DATA.meta.guides[q.subject];
  if (!url && !q.chapter && !q.syllabusItem) return '';
  const ch = q.chapter ? `—【${esc(q.chapter)}】` : '';
  const item = q.syllabusItem ? `▸『${esc(q.syllabusItem)}』` : '';
  const link = url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">開啟學習指引 ↗</a>` : '';
  return `<p class="guide">評鑑範圍對應：${esc(q.subject)} ${ch}${item}${link}</p>`;
}
// 回報這題：開 GitHub issue form,自動帶入題號與科目
function reportLink(q) {
  const url = `https://github.com/yazelin/ipas-ai-quiz/issues/new?template=question-report.yml`
    + `&qid=${encodeURIComponent(q.id)}&subject=${encodeURIComponent(q.subject)}`;
  return `<p class="report-line"><a href="${url}" target="_blank" rel="noopener">這題有誤？回報給作者</a></p>`;
}
// 今日挑戰：用日期當種子，固定挑 3 題（每天不同、當天穩定，優先對齊目標級別）
function dailyChallenge() {
  const lv = prefLevel();
  const pool = (lv === '初級' || lv === '中級') ? DATA.questions.filter((q) => q.level === lv) : DATA.questions;
  const qs = pool.length ? pool : DATA.questions;
  if (!qs.length) return [];
  let seed = 0; for (const ch of today()) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const picks = [];
  for (let n = 0; n < 3 && n < qs.length; n++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    let i = seed % qs.length;
    while (picks.includes(i)) i = (i + 1) % qs.length;
    picks.push(i);
  }
  return picks.map((i) => qs[i]);
}
// 今日觀念卡：優先挑目標級別中「你還沒掌握的章節」(錯題 + 練過未掌握)，逐日輪過；沒練過則全站輪播
function todayConcept() {
  if (!CONCEPTS.length) return null;
  const dayNum = Math.floor(new Date(today() + 'T00:00:00').getTime() / 86400000);
  const lv = prefLevel();
  const basePool = (lv === '初級' || lv === '中級') ? CONCEPTS.filter((c) => c.level === lv) : CONCEPTS;
  const conceptList = basePool.length ? basePool : CONCEPTS;

  const byCh = {};
  for (const q of DATA.questions) {
    if (lv !== '全部' && q.level !== lv) continue;
    const p = store.q[q.id]; if (!p) continue;
    const c = (byCh[q.chapter || q.subject] ||= { attempted: 0, mastered: 0, wrongNow: 0 });
    if (p.attempts > 0) c.attempted++;
    if (isMastered(p.box)) c.mastered++;
    else if (p.wrong > 0) c.wrongNow++;
  }
  const weak = Object.entries(byCh)
    .map(([ch, c]) => ({ ch, score: c.attempted ? c.wrongNow * 2 + (c.attempted - c.mastered) : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (weak.length) {
    const chosen = weak[dayNum % weak.length].ch;
    const pool = conceptList.filter((c) => c.chapter === chosen);
    if (pool.length) return { ...pool[dayNum % pool.length], weak: true };
  }
  return conceptList[((dayNum % conceptList.length) + conceptList.length) % conceptList.length];
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Notion 同步與 Active Recall ----
function extractNotionDbId(raw) {
  if (!raw) return '';
  const s = raw.trim().split('?')[0].split('#')[0];
  const m = s.match(/([0-9a-fA-F]{32})/) || s.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
  if (m) return m[1].replace(/-/g, '').toLowerCase();
  return s.replace(/-/g, '').toLowerCase();
}

function getNotionConfig() {
  const token = (localStorage.getItem('ipas_notion_token') || store.settings?.notionToken || '').trim();
  const rawDb = (localStorage.getItem('ipas_notion_db_id') || store.settings?.notionDbId || '').trim();
  const dbId = extractNotionDbId(rawDb);
  const isLocal = typeof window !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  const defaultProxy = isLocal ? '/notion' : (SYNC_URL ? `${SYNC_URL}/notion` : '/notion');
  const proxy = (localStorage.getItem('ipas_notion_proxy') || store.settings?.notionProxy || '').trim() || defaultProxy;
  return { token, dbId, proxy };
}

async function callNotion(endpoint, { method = 'GET', body = null } = {}) {
  const { token, proxy } = getNotionConfig();
  if (!token) throw new Error('尚未設定 Notion Token');
  const url = `${proxy.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

let cachedDbSchema = null;
async function fetchDbSchema() {
  if (cachedDbSchema) return cachedDbSchema;
  const { dbId } = getNotionConfig();
  if (!dbId) throw new Error('尚未設定 Database ID');
  const db = await callNotion(`databases/${dbId}`);
  cachedDbSchema = db;
  return db;
}

async function syncQuestionToNotion(q, p = {}) {
  const { dbId } = getNotionConfig();
  if (!dbId) throw new Error('尚未設定 Database ID');
  const schema = await fetchDbSchema().catch(() => null);
  const payload = buildNotionPagePayload(q, p, dbId, schema);

  if (p.notionPageId) {
    try {
      // 1. 先更新頁面屬性 (properties)
      const res = await callNotion(`pages/${p.notionPageId}`, {
        method: 'PATCH',
        body: { properties: payload.properties },
      });

      // 2. 獲取既有舊區塊列表
      const existingBlocks = await callNotion(`blocks/${p.notionPageId}/children?page_size=100`);
      const oldBlockIds = (existingBlocks?.results || []).map((b) => b.id);

      // 3. 先追加最新內文區塊（確保新內容已成功寫入，絕不預先刪除造成正文清空）
      if (payload.children?.length) {
        await callNotion(`blocks/${p.notionPageId}/children`, {
          method: 'PATCH',
          body: { children: payload.children },
        });
      }

      // 4. 新內容確認寫入後，再刪除舊區塊（若失敗則拋出錯誤讓介面重試，但新內容已保全）
      for (const oldId of oldBlockIds) {
        await callNotion(`blocks/${oldId}`, { method: 'DELETE' });
      }

      return res;
    } catch (err) {
      // 僅在確認頁面已於 Notion 刪除 (404 / object_not_found) 時才降級為重新建立分頁
      const isNotFound = err.status === 404 || err.code === 'object_not_found' || /not_found/i.test(err.message || '');
      if (isNotFound) {
        delete p.notionPageId;
      } else {
        // 暫時性錯誤或正文寫入失敗直接拋出，不降級為 POST，防止產生重複分頁並讓介面如實回報失敗！
        throw err;
      }
    }
  }

  const result = await callNotion('pages', { method: 'POST', body: payload });
  if (result && result.id) {
    p.notionPageId = result.id;
  }
  return result;
}

// ---- views ----
function setNav(active) {
  clearMockTimer();
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === active));
}

// 範圍 = 章節（若題目尚未分類則退回科目），供「選擇練習範圍」用
const rangeKey = (q) => q.chapter || q.subject;
const srcOf = (q) => q.source || '歷屆';
function rangeGroups() {
  const m = new Map();
  for (const q of DATA.questions) {
    const k = rangeKey(q);
    const g = m.get(k) || { key: k, level: q.level, count: 0 };
    g.count++; m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh-Hant'));
}

function home() {
  setNav('home');
  const groups = rangeGroups();
  const byLevel = {};
  groups.forEach((g) => (byLevel[g.level] ||= []).push(g));
  const ranges = Object.entries(byLevel).map(([lv, gs]) =>
    `<div class="range-group" data-level="${esc(lv)}"><div class="range-lv">${esc(lv)}</div>${gs.map((g) =>
      `<label class="range-item"><input type="checkbox" class="rng" data-level="${esc(lv)}" value="${esc(g.key)}" checked><span>${esc(g.key)}</span><b>${g.count}</b></label>`).join('')}</div>`).join('');
  const g = dailyGoal(), dc = todayCount(), strk = liveStreak(), du = daysUntilExam();
  const et = examTarget();
  const goalHit = dc >= g;
  // 開啟提醒的入口本來只在設定頁最底下,2,137 個人裡只有 17 個找到它。
  // 放在倒數旁邊:看到「還有幾天」的那一刻,才是他真的想要被提醒的時候。
  // 預設隱藏,渲染完非同步查到「還沒訂閱」才顯示,免得已訂閱的人看到重複的邀請。
  const remindCta = du != null && du >= 0 && et && pushSupported() && SYNC_URL
    ? `<div id="remind-cta" hidden><button id="remind-on">考前提醒我</button>
         <span class="muted" id="remind-msg">${et.date}${et.level ? `・${esc(et.level)}` : ''}，每天提醒你刷幾題</span></div>`
    : '';
  const dailyStrip = `
    <section class="card daily-card">
      <div class="daily">
        <div><b class="${goalHit ? 'hit' : ''}">${dc}/${g}</b><span>今日題數${goalHit ? ' ✓' : ''}</span></div>
        <div><b>${strk}</b><span>連續天數</span></div>
        ${du != null ? `<div><b>${du < 0 ? '—' : du}</b><span>${du < 0 ? '考試已過' : `距${et && et.level ? esc(et.level) : ''}考試（天）`}</span></div>` : ''}
      </div>
      ${remindCta}
      <button id="share">分享進度</button>
    </section>`;
  const chDone = store.challengeDone === today();
  const currLv = prefLevel();
  const challengeCard = `
    <section class="card">
      <div class="row"><h3 style="margin:0">今日挑戰 ${chDone ? '✓ 已完成' : '3 題'}</h3>
        <button class="primary" id="challenge" style="margin:0;padding:8px 14px">${chDone ? '再做一次' : '開始'}</button></div>
      <p class="muted" style="margin:6px 0 0">每天 3 題（${currLv === '全部' ? '初級+中級' : currLv}），養成每日刷題的習慣。</p>
    </section>`;
  const cc = todayConcept();
  let conceptCard = '';
  let conceptMatchedQs = [];
  let conceptGuideCard = null;

  if (cc) {
    const cTitle = cc.title.toLowerCase();
    // 嚴謹匹配考點心智卡
    conceptGuideCard = (GUIDE_DATA.cards || []).find((g) => {
      const gTitle = g.title.toLowerCase();
      const mainWords = gTitle.split(/[ (]/)[0];
      if (mainWords.length >= 2 && cTitle.includes(mainWords)) return true;
      return (g.keywords || []).some((kw) => kw.length >= 2 && cTitle.includes(kw.toLowerCase()));
    });

    const kw = cc.title.split(/[ (]/)[0].toLowerCase();
    conceptMatchedQs = DATA.questions.filter((q) => {
      if (cc.chapter && q.chapter === cc.chapter) return true;
      const qText = `${q.question} ${q.options.join(' ')} ${q.topic || ''}`.toLowerCase();
      return qText.includes(kw);
    });

    const guidePdfUrl = (DATA.meta && DATA.meta.guides && DATA.meta.guides[cc.subject]) || '';

    let mainDesc = cc.body || '';
    let examTrapDesc = '';
    const trapIdx = mainDesc.indexOf('考點：');
    if (trapIdx !== -1) {
      examTrapDesc = mainDesc.slice(trapIdx);
      mainDesc = mainDesc.slice(0, trapIdx).trim();
    }

    conceptCard = `
      <section class="card concept-card" style="border:1px solid #bfdbfe;background:linear-gradient(135deg,#f0f7ff 0%,#f8fafc 100%)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px">
          <div class="ck" style="font-weight:700;color:var(--c-accent);font-size:12px">
            💡 今日 AI 觀念${cc.chapter ? ' · ' + esc(cc.chapter) : ''}${cc.weak ? ' · 針對你還沒掌握的弱點範圍' : ''}
          </div>
          ${guidePdfUrl ? `<a href="${esc(guidePdfUrl)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--c-accent);text-decoration:none;font-weight:500">官方學習指引 PDF ↗</a>` : ''}
        </div>
        <h3 style="margin:6px 0 8px;font-size:17px;color:#1e293b">${esc(cc.title)}</h3>
        <p style="margin:0 0 10px;font-size:14px;color:#334155;line-height:1.65">${esc(mainDesc)}</p>

        <details class="concept-details" style="margin:10px 0;background:#fff;border:1px solid #dbeafe;border-radius:8px;padding:8px 12px">
          <summary style="font-weight:600;font-size:13px;color:var(--c-accent);cursor:pointer;user-select:none;outline:none;display:flex;align-items:center;gap:6px">
            <span>🔍 展開詳細說明、情境案例與常考陷阱</span>
          </summary>
          <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;font-size:13px;line-height:1.65;color:#1e293b">
            ${conceptGuideCard?.subtitle ? `<div style="font-size:14px;font-weight:700;color:#1d4ed8;margin-bottom:8px">📌 ${esc(conceptGuideCard.subtitle)}</div>` : ''}
            ${conceptGuideCard?.function ? `<div style="margin-bottom:8px"><b>🎯 核心功能與計算意義：</b><br>${esc(conceptGuideCard.function)}</div>` : ''}
            ${conceptGuideCard?.scenario ? `<div style="margin-bottom:8px"><b>💡 實戰生活案例與考題情境：</b><br>${esc(conceptGuideCard.scenario)}</div>` : ''}
            ${conceptGuideCard?.trap ? `<div style="margin-bottom:8px;padding:6px 10px;background:#fef2f2;border-left:3px solid #ef4444;border-radius:4px;color:#991b1b"><b>⚠️ 常考盲點與防呆陷阱：</b><br>${esc(conceptGuideCard.trap)}</div>` : ''}
            ${examTrapDesc ? `<div style="margin-top:8px;padding:6px 10px;background:#f8fafc;border-left:3px solid #64748b;border-radius:4px;color:#334155"><b>📝 官方評鑑考點提示：</b><br>${esc(examTrapDesc)}</div>` : ''}
          </div>
        </details>

        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
          ${conceptMatchedQs.length ? `<button class="primary" id="drill-concept-qs" style="margin:0;padding:7px 14px;font-size:13px;font-weight:600">🎯 特訓此考點題目 (${conceptMatchedQs.length} 題)</button>` : ''}
          ${conceptGuideCard ? `<button class="goto" id="goto-concept-guide" style="margin:0;padding:7px 14px;font-size:13px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;font-weight:600">📖 考點速查心智卡內鏈</button>` : ''}
        </div>
      </section>`;
  }

  const dueQs = getDueQuestions();
  const dueCs = getDueCards();
  const reviewBanner = (dueQs.length > 0 || dueCs.length > 0) ? `
    <section class="card review-card">
      <div class="row">
        <div>
          <h3 style="margin:0">⏳ 艾賓浩斯遺忘曲線 · 今日待複習</h3>
          <p class="muted" style="margin:4px 0 0">
            ${dueQs.length ? `有 <b>${dueQs.length}</b> 題題目到期待複習` : ''}${dueQs.length && dueCs.length ? '，' : ''}${dueCs.length ? `<b>${dueCs.length}</b> 張心智卡待複習` : ''}！趁遺忘前鞏固記憶。
          </p>
        </div>
        ${dueQs.length ? `<button class="primary" id="start-ebbinghaus" style="margin:0;padding:8px 14px;white-space:nowrap">立即複習題目 (${dueQs.length})</button>` : ''}
      </div>
    </section>` : '';

  const bCount = DATA.questions.filter((q) => q.level === '初級').length;
  const mCount = DATA.questions.filter((q) => q.level === '中級').length;
  const totalCount = DATA.questions.length;

  const mockSess = store.mockSession;
  const mockSessBanner = (mockSess && mockSess.poolIds && mockSess.poolIds.length) ? `
    <section class="card" style="background:#eff6ff;border:1px solid #bfdbfe">
      <div class="row">
        <div>
          <h3 style="margin:0;color:#1e40af">📌 上次做到一半的模擬考</h3>
          <p class="muted" style="margin:4px 0 0;color:#2563eb">
            ${esc(mockSess.paperName)}（已答 ${(mockSess.answers || []).filter(a => a !== null).length} / ${mockSess.poolIds.length} 題，剩餘約 ${Math.max(1, Math.round(mockSess.remaining / 60))} 分鐘）
          </p>
        </div>
        <button class="primary" id="home-resume-mock" style="margin:0;padding:8px 14px;white-space:nowrap">繼續作答</button>
      </div>
    </section>
  ` : '';
  
  const featureUpgradeBanner = `
    <section class="card" style="background:linear-gradient(135deg,#eff6ff 0%,#f0fdf4 100%);border:1px solid #bfdbfe;border-radius:12px;padding:14px 16px;margin-bottom:12px">
      <div style="font-weight:700;color:#1e40af;font-size:15px;margin-bottom:6px;display:flex;align-items:center;gap:6px">
        <span>✨ 全新改版已生效：標準化四段詳解 ＆ 做到一半就好</span>
      </div>
      <div style="margin:0;font-size:13px;color:#334155;line-height:1.7">
        <div>📌 <b>1. 四段標準化題庫</b>：作答後即時展示<b>【題目】｜【答案】｜【📝 考生思路輸入】｜【🤖 AI 檢查逐項分析】</b>（初級 919 題已全數補齊！）。</div>
        <div>⏱️ <b>2. 做到一半就好</b>：
          模擬考新增<b>「半份試卷（25 題）」</b>；作答中隨時可<b>「提前交卷」</b>或<b>「暫存離開」</b>；練習模式隨時可<b>「提早結束」</b>看弱點！
        </div>
      </div>
    </section>
  `;
  view.innerHTML = `${dailyStrip}${featureUpgradeBanner}${mockSessBanner}${reviewBanner}${challengeCard}${conceptCard}
    <section class="card">
      <h2>練習模式</h2>
      <p class="muted">即時看答案與解析。切換級別並勾選要練的範圍，預設全選。</p>
      <div class="level-tabs" id="pr-level-tabs">
        <button class="level-tab ${currLv === '初級' ? 'on' : ''}" data-lv="初級">初級（${bCount} 題）</button>
        <button class="level-tab ${currLv === '中級' ? 'on' : ''}" data-lv="中級">中級（${mCount} 題）</button>
        <button class="level-tab ${currLv === '全部' ? 'on' : ''}" data-lv="全部">全部（${totalCount} 題）</button>
      </div>
      <div class="row range-head"><span class="muted" id="range-sum"></span>
        <span><button id="sel-all">全選</button><button id="sel-none">清除</button></span></div>
      <div id="ranges">${ranges}</div>
      <label>關鍵字（選填）
        <input id="pr-kw" placeholder="例如 RAG、特徵工程、Transformer">
      </label>
      <label>出題方式
        <select id="pr-mode">
          <option value="smart">智慧複習（優先錯題與沒做過的）</option>
          <option value="ebbinghaus">遺忘曲線複習（只練已排程且到期的題目）</option>
          <option value="random">隨機</option>
        </select>
      </label>
      <label>題數
        <select id="pr-count"><option value="10">10 題</option><option value="25">25 題（半份範圍，做到一半就好）</option><option value="20">20 題</option><option value="5">5 題（快速熱身）</option><option value="0">全部（選取範圍）</option></select>
      </label>
      <label>來源
        <select id="pr-source">
          <option value="">全部（歷屆 + 學習指引）</option>
          <option value="歷屆">只練歷屆考古題</option>
          <option value="學習指引">只練學習指引範例</option>
        </select>
      </label>
      <button class="primary" id="pr-start">開始練習</button>
      <button class="primary alt" id="pr-images">只練看圖題（${DATA.questions.filter((q) => q.image).length} 題,全中級）</button>
    </section>`;

  let activeLevel = currLv;
  const selectedKeys = () => new Set([...view.querySelectorAll('.rng:checked')].map((c) => c.value));
  const kw = () => $('#pr-kw').value.trim().toLowerCase();
  const matchKw = (q) => {
    const k = kw();
    if (!k) return true;
    return `${q.question}${q.topic || ''}${q.chapter || ''}${q.options.join(' ')}`.toLowerCase().includes(k);
  };
  const pickPool = () => {
    const keys = selectedKeys();
    const src = $('#pr-source') ? $('#pr-source').value : '';
    const mode = $('#pr-mode') ? $('#pr-mode').value : 'smart';
    const now = Date.now();
    return DATA.questions.filter((q) => {
      if (mode === 'ebbinghaus') {
        const p = store.q[q.id];
        if (!p || !p.reviewDue || p.reviewDue > now) return false;
      }
      return (activeLevel === '全部' || q.level === activeLevel) &&
        keys.has(rangeKey(q)) &&
        matchKw(q) &&
        (!src || srcOf(q) === src);
    });
  };
  const updateSum = () => {
    const pool = pickPool();
    const tag = activeLevel === '全部' ? '全部' : activeLevel;
    const mode = $('#pr-mode') ? $('#pr-mode').value : '';
    const modeDesc = mode === 'ebbinghaus' ? '［遺忘曲線到期題］' : '';
    $('#range-sum').textContent = `已選範圍共 ${pool.length} 題（${tag}${modeDesc}）`;
  };
  const setLevelTab = (lv) => {
    activeLevel = lv;
    store.settings ||= { dailyGoal: 20, examDate: '' };
    store.settings.prefLevel = lv;
    save();
    view.querySelectorAll('#pr-level-tabs .level-tab').forEach((b) => b.classList.toggle('on', b.dataset.lv === lv));
    view.querySelectorAll('.range-group').forEach((g) => {
      const match = lv === '全部' || g.dataset.level === lv;
      g.style.display = match ? '' : 'none';
      if (match) {
        const boxes = g.querySelectorAll('.rng');
        if (![...boxes].some((b) => b.checked)) boxes.forEach((b) => (b.checked = true));
      }
    });
    if ($('#pr-images')) {
      $('#pr-images').style.display = (lv === '初級') ? 'none' : '';
    }
    updateSum();
  };

  view.querySelectorAll('#pr-level-tabs .level-tab').forEach((b) => {
    b.onclick = () => setLevelTab(b.dataset.lv);
  });
  view.querySelectorAll('.rng').forEach((c) => (c.onchange = updateSum));
  $('#pr-kw').oninput = updateSum;
  $('#pr-source').onchange = updateSum;
  $('#pr-mode').onchange = updateSum;
  $('#sel-all').onclick = () => {
    view.querySelectorAll('.range-group').forEach((g) => {
      if (activeLevel === '全部' || g.dataset.level === activeLevel) {
        g.querySelectorAll('.rng').forEach((c) => (c.checked = true));
      }
    });
    updateSum();
  };
  $('#sel-none').onclick = () => {
    view.querySelectorAll('.range-group').forEach((g) => {
      if (activeLevel === '全部' || g.dataset.level === activeLevel) {
        g.querySelectorAll('.rng').forEach((c) => (c.checked = false));
      }
    });
    updateSum();
  };
  setLevelTab(activeLevel);

  if ($('#start-ebbinghaus')) {
    $('#start-ebbinghaus').onclick = () => runPractice(shuffle(dueQs));
  }
  if ($('#drill-concept-qs')) {
    $('#drill-concept-qs').onclick = () => runPractice(shuffle(conceptMatchedQs));
  }
  if ($('#goto-concept-guide')) {
    $('#goto-concept-guide').onclick = () => {
      guideActiveCat = '全部';
      guideSearchKw = (conceptGuideCard?.title || cc?.title || '').split(/[ (]/)[0];
      guide();
    };
  }
  if ($('#home-resume-mock')) $('#home-resume-mock').onclick = mockSetup;
  $('#pr-start').onclick = () => {
    const count = +$('#pr-count').value;
    const mode = $('#pr-mode').value;
    let pool = pickPool();
    if (!pool.length) {
      alert('所選範圍目前沒有符合條件的題目！');
      return;
    }

    const now = Date.now();
    const COOLDOWN_MS = 20 * 60 * 1000; // 20 分鐘冷卻期（避免剛做完的題目立刻又在下一輪出現）

    if (mode === 'smart') {
      // 智慧排程：解決「總感覺一直重複練一樣題目」的根本問題
      // 1. 分流題目池
      const activeWrong = []; // Box 1 且未在冷卻中的錯題
      const newQuestions = []; // 從沒做過的新題
      const reviewing = []; // Box 2 進入鞏固期且未在冷卻中的題目
      const mastered = []; // Box 3 已掌握的題目
      const coolingDown = []; // 剛在 20 分鐘內做過、冷卻中的題目

      for (const q of pool) {
        const p = store.q[q.id];
        if (!p || (p.attempts || 0) === 0) {
          newQuestions.push(q);
        } else if (p.lastAnsweredAt && now - p.lastAnsweredAt < COOLDOWN_MS) {
          coolingDown.push(q);
        } else if (isMastered(p.box)) {
          mastered.push(q);
        } else if (p.box === 1 && p.wrong > 0) {
          activeWrong.push(q);
        } else {
          reviewing.push(q);
        }
      }

      // 如果全部題目都還在冷卻中（題目池很小），則釋放冷卻題目
      const availableWrong = activeWrong.length ? activeWrong : coolingDown.filter(q => (store.q[q.id]?.box === 1 && store.q[q.id]?.wrong > 0));
      const availableReview = reviewing.length ? reviewing : coolingDown.filter(q => (store.q[q.id]?.box === 2));

      // 若指定題數（如 10 題、20 題、25 題）
      if (count > 0) {
        // 黃金配比：最多 30%~40% 錯題/複習題 + 60%~70% 新題目
        const maxReviewCount = Math.max(1, Math.round(count * 0.35));

        // 挑選複習題（錯題優先，其次鞏固題）
        const reviewPicks = shuffle([...availableWrong, ...availableReview]).slice(0, maxReviewCount);
        // 挑選新題
        const newPicks = shuffle(newQuestions).slice(0, count - reviewPicks.length);

        let finalPool = [...reviewPicks, ...newPicks];

        // 若新題或複習題不夠填滿 count，用剩餘可用題（已掌握或冷卻題）隨機補齊
        if (finalPool.length < count) {
          const pickedIds = new Set(finalPool.map(q => q.id));
          const remainingPool = shuffle(pool.filter(q => !pickedIds.has(q.id)));
          finalPool = finalPool.concat(remainingPool.slice(0, count - finalPool.length));
        }

        pool = shuffle(finalPool);
      } else {
        // 全卷模式：錯題 ➔ 新題 ➔ 鞏固題 ➔ 已掌握
        pool = [
          ...shuffle(availableWrong),
          ...shuffle(newQuestions),
          ...shuffle(availableReview),
          ...shuffle(mastered)
        ];
      }
    } else if (mode === 'new') {
      // 只練新題
      const newQs = pool.filter(q => !store.q[q.id] || (store.q[q.id].attempts || 0) === 0);
      if (!newQs.length) {
        alert('恭喜！所選範圍的所有題目你都已經至少做過一次！已為你切換為複習練習。');
        pool = shuffle(pool);
      } else {
        pool = shuffle(newQs);
      }
      if (count) pool = pool.slice(0, count);
    } else if (mode === 'wrong') {
      // 只練當前錯題
      const wrongQs = pool.filter(q => {
        const p = store.q[q.id];
        return p && p.box < 3 && (p.wrong || 0) > 0;
      });
      if (!wrongQs.length) {
        alert('所選範圍目前沒有待複習的錯題！已自動為你挑選新題目。');
        pool = shuffle(pool);
      } else {
        pool = shuffle(wrongQs);
      }
      if (count) pool = pool.slice(0, count);
    } else if (mode === 'ebbinghaus') {
      // 遺忘曲線到期題
      const dueQs = pool.filter(q => {
        const p = store.q[q.id];
        return p && p.reviewDue && p.reviewDue <= now;
      });
      if (!dueQs.length) {
        alert('目前所選範圍沒有到期的遺忘曲線題目！已為你挑選新題與鞏固練習。');
        pool = shuffle(pool);
      } else {
        pool = shuffle(dueQs);
      }
      if (count) pool = pool.slice(0, count);
    } else {
      // 完全隨機
      pool = shuffle(pool);
      if (count) pool = pool.slice(0, count);
    }

    runPractice(pool);
  };
  $('#pr-images').onclick = () => runPractice(shuffle(DATA.questions.filter((q) => q.image)));
  $('#challenge').onclick = () => { store.challengeDone = today(); save(); runPractice(dailyChallenge()); };
  if ($('#remind-cta')) {
    pushIsOn().then((on) => { if (!on) $('#remind-cta').hidden = false; }).catch(() => {});
    $('#remind-on').onclick = async () => {
      const btn = $('#remind-on'); btn.disabled = true; btn.textContent = '設定中…';
      const r = await enablePush((store.settings && store.settings.reminderHour) || 20).catch(() => ({ ok: false }));
      btn.textContent = r.ok ? '已開啟提醒' : '開啟失敗';
      // 失敗多半是使用者按了「封鎖通知」,或 iPhone 沒把本站加到主畫面。指路到設定頁,那裡有完整說明。
      $('#remind-msg').textContent = r.ok
        ? '每天 20:00 提醒，時間可到設定頁改'
        : (r.reason || '這台裝置開不起來，設定頁有說明');
      btn.disabled = !r.ok;
      if (r.ok) btn.disabled = true;
    };
  }
  $('#share').onclick = async () => {
    const cd = (du != null && du >= 0) ? `、距考試 ${du} 天` : '';
    const txt = `我在 iPAS AI 應用規劃師模擬考刷題：連續打卡 ${strk} 天、今日 ${dc}/${g} 題${cd}。一起來練官方試題！`;
    const url = location.origin + location.pathname;
    if (navigator.share) { try { await navigator.share({ title: 'iPAS 模考練習', text: txt, url }); } catch {} }
    else { try { await navigator.clipboard.writeText(`${txt} ${url}`); $('#share').textContent = '已複製連結'; } catch {} }
  };
  updateSum();
}

function runPractice(pool, opts = {}) {
  clearMockTimer();
  let i = 0;
  let right = 0, wrong = 0;
  let showCurrentMeta = false;
  const sessionWrong = [];

  if (!pool.length) {
    view.innerHTML = `
      <section class="card">
        <h2>練習</h2>
        <p class="muted">目前沒有符合條件的題目。</p>
        <button id="back-home">回首頁</button>
      </section>`;
    $('#back-home').onclick = home;
    return;
  }

  const render = () => {
    const q = pool[i];
    const p = qp(q.id);
    const reviewBtnClass = p.reviewDue ? 'review-btn active' : 'review-btn';
    const reviewBtnText = p.reviewDue ? '🧠 複習中' : '🧠 加入複習';

    view.innerHTML = `
      <section class="card">
        <div class="row">
          <span class="muted">${i + 1} / ${pool.length}</span>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="${reviewBtnClass}" id="review-btn" title="基於艾賓浩斯遺忘曲線排程複習">${reviewBtnText}</button>
            <button class="star ${p.starred ? 'on' : ''}" id="star">${p.starred ? '★ 已標' : '☆ 標記'}</button>
          </div>
        </div>
        <div class="meta-box" style="margin:8px 0 12px">
          <button class="meta-toggle-btn" id="toggle-meta-btn" style="cursor:pointer;font-size:13px;padding:5px 12px;border-radius:8px;background:${showCurrentMeta ? '#eff6ff' : '#f8fafc'};border:1px solid ${showCurrentMeta ? '#93c5fd' : '#cbd5e1'};color:${showCurrentMeta ? '#1d4ed8' : '#475569'};display:inline-flex;align-items:center;gap:6px;font-weight:${showCurrentMeta ? '600' : 'normal'}">
            ${showCurrentMeta ? '🙈 隱藏考點提示' : '👁️ 點擊顯示考點提示'}
          </button>
          ${showCurrentMeta
            ? `<p class="qmeta muted" style="margin:8px 0 0;padding:8px 12px;background:#f8fafc;border-radius:8px;border-left:3px solid var(--c-accent);font-size:13px;line-height:1.5">${esc(q.subject)}${q.chapter ? '・' + esc(q.chapter) : ''}${q.syllabusItem ? ' ▸ ' + esc(q.syllabusItem) : ''}${q.topic ? '（' + esc(q.topic) + '）' : ''}${q.source === '學習指引' ? ' <span class="src-tag">學習指引範例</span>' : ''}</p>`
            : ''}
        </div>
        <h3>${esc(q.question)}</h3>
        ${q.image ? `<img class="qfig" src="${esc(q.image)}" alt="題目附圖" loading="lazy">` : ''}
        <div id="opts">${q.options.map((o, k) => `<button class="opt" data-k="${k}">${esc(o)}</button>`).join('')}</div>
        <div id="fb"></div>
      </section>`;

    $('#star').onclick = () => {
      p.starred = !p.starred;
      const now = Date.now();
      p.starredUpdatedAt = now;
      p.updatedAt = now;
      save();
      render();
    };
    $('#toggle-meta-btn').onclick = () => {
      showCurrentMeta = !showCurrentMeta;
      render();
    };
    $('#review-btn').onclick = () => {
      const now = Date.now();
      if (p.reviewDue) {
        delete p.reviewDue;
        delete p.reviewStage;
      } else {
        const next = calcNextReview(0, true);
        p.reviewStage = next.stage;
        p.reviewDue = next.due;
      }
      p.reviewUpdatedAt = now;
      p.updatedAt = now;
      save();
      render();
    };
    view.querySelectorAll('.opt').forEach((btn) =>
      (btn.onclick = () => answer(q, +btn.dataset.k)));
  };

  const answer = (q, k) => {
    const p = qp(q.id);
    const correct = k === q.answer;
    p.attempts++;
    p.lastAnsweredAt = Date.now();
    p.updatedAt = Date.now();
    if (correct) { p.correct++; right++; } else { p.wrong++; wrong++; sessionWrong.push(q); }
    p.box = nextBox(p.box, correct);

    const next = calcNextReview(p.reviewStage || (correct ? 1 : 0), correct);
    p.reviewStage = next.stage;
    p.reviewDue = next.due;
    const reviewUpdateMsg = `<span class="review-badge ${correct ? '' : 'due'}" style="margin-top:6px;display:inline-block">
      🧠 遺忘曲線排程：第 ${next.stage} 階段（${next.days} 天後再次複習）
    </span>`;

    logRecent(correct);
    bumpDaily(correct);
    save();
    view.querySelectorAll('.opt').forEach((b, idx) => {
      b.disabled = true;
      if (idx === q.answer) b.classList.add('correct');
      if (idx === k && !correct) b.classList.add('wrong');
    });

    const relatedCards = (GUIDE_DATA.cards || []).filter((c) => {
      if (q.syllabusItem && c.syllabusItem === q.syllabusItem) return true;
      const text = `${q.question} ${q.options.join(' ')} ${q.topic || ''}`.toLowerCase();
      return (c.keywords || []).some((kw) => text.includes(kw.toLowerCase()));
    });
    const cardShortcut = relatedCards.length
      ? `<button class="guide-copy-btn" id="jump-guide-card" style="margin-top:6px">📖 查看此題考點心智卡：${esc(relatedCards[0].title.split('(')[0].trim())}</button>`
      : '';

    $('#fb').innerHTML = `
      <p class="${correct ? 'ok' : 'bad'}">${correct ? '答對' : '答錯'}（正解：${esc(q.options[q.answer])}）</p>
      ${reviewUpdateMsg ? `<div>${reviewUpdateMsg}</div>` : ''}
      ${q.explanation ? `<p class="exp">${formatExp(q.explanation)}</p>` : ''}
      ${guideLine(q)}
      ${cardShortcut ? `<div>${cardShortcut}</div>` : ''}
      ${reportLink(q)}

      <div style="margin:12px 0;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
        <label class="note" style="margin:0 0 8px;font-weight:600;font-size:13px;color:#1e293b">
          📝 考生回答與解題思路（比對盲點與各選項陷阱）：
          <textarea id="student-answer" rows="2" placeholder="寫下你的解題邏輯，例：我選 ${'ABCD'[k]} 是因為...，選項 A 錯在...">${esc(p.studentAnswer || '')}</textarea>
        </label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="guide-copy-btn" id="analyze-student-btn" style="background:#f0fdf4;border:1px solid #86efac;color:#166534;font-weight:600">
            🤖 AI 檢查考生回答（診斷思路與陷阱）
          </button>
          <span id="ai-status-hint" class="muted" style="font-size:12px"></span>
        </div>
        <div id="ai-student-feedback" style="margin-top:10px"></div>
      </div>

      <div class="notion-row">
        <button class="notion-btn" id="notion-sync-btn">${p.notionSyncedAt ? '✓ 已在 Notion' : '📌 存入 Notion'}</button>
        <button class="notion-btn alt" id="notion-copy-btn">📋 複製 Notion 摺疊格式</button>
        <span id="notion-single-msg" class="muted" style="font-size:12px"></span>
      </div>
      <label class="note">筆記<textarea id="note" rows="2" placeholder="寫下你的個人重點摘要…">${esc(p.note || '')}</textarea></label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
        <button class="primary" id="next" style="margin:0">${i + 1 < pool.length ? '下一題' : '完成'}</button>
        ${i + 1 < pool.length ? `<button id="early-finish" style="margin:0;background:#f8fafc;border:1px solid #cbd5e1;color:#475569">提早結束本次練習（已做 ${i + 1} 題）</button>` : ''}
      </div>`;

    const renderAiFeedback = () => {
      const diag = diagnoseStudentAnswer(q, k, p.studentAnswer || '');
      const fbBox = $('#ai-student-feedback');
      if (!fbBox) return;

      const matchedHtml = diag.matchedKeywords.length
        ? `<div style="margin:4px 0;font-size:13px"><span style="color:#0369a1;font-weight:600">📋 提及相關考點詞：</span>${diag.matchedKeywords.map((kw) => `<span style="background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:4px;font-size:12px;margin-right:4px">${esc(kw)}</span>`).join('')}</div>`
        : '';
      const negationWarningHtml = diag.hasNegation
        ? `<div style="margin:4px 0;padding:6px 10px;background:#fffbeb;border:1px solid #fef3c7;border-radius:6px;font-size:12.5px;color:#92400e;line-height:1.4">⚠️ <b>提醒：</b>自述包含否定或限制詞彙，請對照下方解析確認是否為反向猜對或誤判條件。</div>`
        : '';
      const missingHtml = diag.missingKeywords.length && (p.studentAnswer || '').trim()
        ? `<div style="margin:4px 0;font-size:13px"><span style="color:#d97706;font-weight:600">💡 建議補充思考：</span>${diag.missingKeywords.map((kw) => `<span style="background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:4px;font-size:12px;margin-right:4px">${esc(kw)}</span>`).join('')}</div>`
        : '';

      const optionsTable = `
        <div style="margin-top:8px;border-top:1px dashed #cbd5e1;padding-top:8px">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px;color:#334155">【各選項解析與干擾陷阱剖析】</div>
          ${diag.optionBreakdowns.map((ob) => `
            <div style="margin:4px 0;padding:6px 8px;border-radius:6px;background:${ob.isCorrect ? '#f0fdf4' : ob.isPicked ? '#fef2f2' : '#ffffff'};border:1px solid ${ob.isCorrect ? '#bbf7d0' : ob.isPicked ? '#fecaca' : '#e2e8f0'};font-size:13px">
              <b>${ob.letter}.</b> ${esc(ob.text)}
              <span style="display:inline-block;margin-left:6px;font-weight:600;color:${ob.isCorrect ? '#16a34a' : '#dc2626'}">${ob.isCorrect ? '【正解】' : ob.isPicked ? '【你的選擇・陷阱】' : '【錯誤】'}</span>
              <div style="margin-top:3px;color:#475569;font-size:12.5px;line-height:1.4">${esc(ob.analysis)}</div>
            </div>
          `).join('')}
        </div>
      `;

      fbBox.innerHTML = `
        <div style="background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-weight:700;font-size:14px;color:${diag.isCorrect ? '#166534' : '#991b1b'}">${diag.statusSummary}</span>
          </div>
          <p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#1e293b">${esc(diag.advice)}</p>
          ${negationWarningHtml}
          ${matchedHtml}
          ${missingHtml}
          ${optionsTable}
          <div class="muted" style="font-size:11.5px;margin-top:6px;line-height:1.4;color:#64748b">
            註：AI 思路比對依據關鍵詞與語意標籤輔助自查，真實理解程度請以官方詳解之因果論證為準，切勿僅憑提及名詞斷定完全掌握。
          </div>
        </div>
      `;
    };

    if (p.studentAnswer) {
      renderAiFeedback();
    }

    $('#analyze-student-btn').onclick = () => {
      renderAiFeedback();
      $('#ai-status-hint').textContent = '✓ 已完成 AI 診斷比對';
    };

    if ($('#jump-guide-card')) {
      $('#jump-guide-card').onclick = () => {
        guideActiveCat = '全部';
        guideSearchKw = relatedCards[0].title.split(' ')[0];
        guide();
      };
    }
    if ($('#notion-sync-btn')) $('#notion-sync-btn').onclick = async () => {
      const btn = $('#notion-sync-btn');
      const msg = $('#notion-single-msg');
      const { token, dbId } = getNotionConfig();
      if (!token || !dbId) {
        msg.textContent = '請先在「設定」填入 Notion Token 與 Database ID';
        return;
      }
      btn.disabled = true;
      btn.textContent = '同步中…';
      try {
        await syncQuestionToNotion(q, p);
        p.notionSyncedAt = Date.now();
        p.updatedAt = Date.now();
        save();
        btn.textContent = '✓ 已存入 Notion';
        msg.textContent = '已成功同步至 Notion 資料庫！';
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '📌 存入 Notion';
        msg.textContent = `失敗：${err.message}`;
      }
    };
    if ($('#notion-copy-btn')) $('#notion-copy-btn').onclick = async () => {
      const text = toNotionMarkdown([q], { [q.id]: p });
      try {
        await navigator.clipboard.writeText(text);
        $('#notion-single-msg').textContent = '✓ 已複製 Notion Toggle 格式，可直接貼入 Notion！';
      } catch {
        $('#notion-single-msg').textContent = '複製失敗';
      }
    };
    if ($('#student-answer')) {
      $('#student-answer').oninput = (e) => {
        p.studentAnswer = e.target.value;
        const now = Date.now();
        p.noteUpdatedAt = now;
        p.updatedAt = now;
        save();
      };
    }
    $('#note').oninput = (e) => {
      p.note = e.target.value;
      const now = Date.now();
      p.noteUpdatedAt = now;
      p.updatedAt = now;
      save();
    };
    if ($('#early-finish')) $('#early-finish').onclick = () => finish();
    $('#next').onclick = () => {
      i++;
      showCurrentMeta = false;
      i < pool.length ? render() : finish();
    };
  };
  const finish = () => {
    pushSync(); // checkpoint:練習完成立即上傳
    const total = right + wrong;
    const pct = total ? Math.round((right / total) * 1000) / 10 : 0;

    // 進步的第一性原理是補不會：統計本次錯題落在哪些官方評鑑範圍
    const wrongByItem = {};
    for (const wq of sessionWrong) {
      const key = wq.syllabusItem || wq.chapter || wq.subject;
      (wrongByItem[key] ||= { chapter: wq.chapter, item: key, qs: [] }).qs.push(wq);
    }
    const weakDiagnosticHtml = Object.values(wrongByItem).length ? `
      <div style="margin:14px 0;padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px">
        <h3 style="margin:0 0 6px;color:#b91c1c;font-size:15px">🎯 進步的第一性原理是「補不會」：本次待補強評鑑範圍</h3>
        <p class="muted" style="margin:0 0 8px;font-size:13px">別無腦刷題！以下是你剛才答錯所對應的官方評鑑內容，點擊可直接針對該範圍全部題目特訓：</p>
        ${Object.values(wrongByItem).map((g) => {
          const allInScope = DATA.questions.filter((x) => (x.syllabusItem || x.chapter || x.subject) === g.item);
          return `<div class="row" style="padding:6px 0;border-top:1px dashed #fca5a5">
            <span style="font-size:14px"><b>${esc(g.item)}</b> <span class="muted">（本次錯 ${g.qs.length} 題）</span></span>
            <button class="goto drill-scope-btn" data-scope="${esc(g.item)}" style="background:#fee2e2;color:#b91c1c;font-weight:600">特訓此範圍 (${allInScope.length} 題)</button>
          </div>`;
        }).join('')}
      </div>
    ` : '';

    view.innerHTML = `
      <section class="card">
        <h2>練習完成</h2>
        <p class="score">${pct}％</p>
        <p>這組 ${total} 題,答對 ${right}、答錯 ${wrong}</p>
        ${weakDiagnosticHtml}
        ${sessionWrong.length ? '<button class="primary" id="redo-wrong">只練這次錯的</button>' : '<p class="muted">這組全對,讚!</p>'}
        <button id="again">再練一次</button>
        <button id="back">回首頁</button>
      </section>`;
    if (sessionWrong.length) $('#redo-wrong').onclick = () => runPractice(sessionWrong.slice());
    view.querySelectorAll('.drill-scope-btn').forEach((btn) => {
      btn.onclick = () => {
        const sc = btn.dataset.scope;
        const scopePool = DATA.questions.filter((x) => (x.syllabusItem || x.chapter || x.subject) === sc);
        runPractice(shuffle(scopePool));
      };
    });
    $('#again').onclick = () => runPractice(shuffle(pool.slice()));
    $('#back').onclick = home;
  };
  render();
};
    $('#toggle-meta-btn').onclick = () => {
      showCurrentMeta = !showCurrentMeta;
      render();
    };
    $('#review-btn').onclick = () => {
      if (p.reviewDue) {
        delete p.reviewDue;
        delete p.reviewStage;
      } else {
        const next = calcNextReview(0, true);
        p.reviewStage = next.stage;
        p.reviewDue = next.due;
      }
      save();
      render();
    };
    view.querySelectorAll('.opt').forEach((btn) =>
      (btn.onclick = () => answer(q, +btn.dataset.k)));
  };
  const answer = (q, k) => {
    const p = qp(q.id);
    const correct = k === q.answer;
        p.attempts++;
    p.lastAnsweredAt = Date.now();
    if (correct) { p.correct++; right++; } else { p.wrong++; wrong++; sessionWrong.push(q); }
    p.box = nextBox(p.box, correct);

    // 自動排程遺忘曲線：作答後自動推進或排程複習
    const next = calcNextReview(p.reviewStage || (correct ? 1 : 0), correct);
    p.reviewStage = next.stage;
    p.reviewDue = next.due;
    const reviewUpdateMsg = `<span class="review-badge ${correct ? '' : 'due'}" style="margin-top:6px;display:inline-block">
      🧠 遺忘曲線排程：第 ${next.stage} 階段（${next.days} 天後再次複習）
    </span>`;

    logRecent(correct);
    bumpDaily(correct);
    save();
    view.querySelectorAll('.opt').forEach((b, idx) => {
      b.disabled = true;
      if (idx === q.answer) b.classList.add('correct');
      if (idx === k && !correct) b.classList.add('wrong');
    });

    // 若有對應的考點心智卡，提供一鍵跳轉查看原理
    const relatedCards = (GUIDE_DATA.cards || []).filter((c) => {
      if (q.syllabusItem && c.syllabusItem === q.syllabusItem) return true;
      const text = `${q.question} ${q.options.join(' ')} ${q.topic || ''}`.toLowerCase();
      return (c.keywords || []).some((kw) => text.includes(kw.toLowerCase()));
    });
    const cardShortcut = relatedCards.length
      ? `<button class="guide-copy-btn" id="jump-guide-card" style="margin-top:6px">📖 查看此題考點心智卡：${esc(relatedCards[0].title.split('(')[0].trim())}</button>`
      : '';

    $('#fb').innerHTML = `
      <p class="${correct ? 'ok' : 'bad'}">${correct ? '答對' : '答錯'}（正解：${esc(q.options[q.answer])}）</p>
      ${reviewUpdateMsg ? `<div>${reviewUpdateMsg}</div>` : ''}
      ${q.explanation ? `<p class="exp">${formatExp(q.explanation)}</p>` : ''}
      ${guideLine(q)}
      ${cardShortcut ? `<div>${cardShortcut}</div>` : ''}
      ${reportLink(q)}
      <div class="notion-row">
        <button class="notion-btn" id="notion-sync-btn">${p.notionSyncedAt ? '✓ 已在 Notion' : '📌 存入 Notion'}</button>
        <button class="notion-btn alt" id="notion-copy-btn">📋 複製 Notion 摺疊格式</button>
        <span id="notion-single-msg" class="muted" style="font-size:12px"></span>
      </div>
      <label class="note">筆記<textarea id="note" rows="2" placeholder="寫下你的理解或記憶點…">${esc(p.note || '')}</textarea></label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
        <button class="primary" id="next" style="margin:0">${i + 1 < pool.length ? '下一題' : '完成'}</button>
        ${i + 1 < pool.length ? `<button id="early-finish" style="margin:0;background:#f8fafc;border:1px solid #cbd5e1;color:#475569">提早結束本次練習（已做 ${i + 1} 題）</button>` : ''}
      </div>`;
    if ($('#jump-guide-card')) {
      $('#jump-guide-card').onclick = () => {
        guideActiveCat = '全部';
        guideSearchKw = relatedCards[0].title.split(' ')[0];
        guide();
      };
    }
    if ($('#notion-sync-btn')) $('#notion-sync-btn').onclick = async () => {
      const btn = $('#notion-sync-btn');
      const msg = $('#notion-single-msg');
      const { token, dbId } = getNotionConfig();
      if (!token || !dbId) {
        msg.textContent = '請先在「設定」填入 Notion Token 與 Database ID';
        return;
      }
      btn.disabled = true;
      btn.textContent = '同步中…';
      try {
        await syncQuestionToNotion(q, p);
        p.notionSyncedAt = Date.now();
        save();
        btn.textContent = '✓ 已存入 Notion';
        msg.textContent = '已成功同步至 Notion 資料庫！';
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '📌 存入 Notion';
        msg.textContent = `失敗：${err.message}`;
      }
    };
    if ($('#notion-copy-btn')) $('#notion-copy-btn').onclick = async () => {
      const text = toNotionMarkdown([q], { [q.id]: p });
      try {
        await navigator.clipboard.writeText(text);
        $('#notion-single-msg').textContent = '✓ 已複製 Notion Toggle 格式，可直接貼入 Notion！';
      } catch {
        $('#notion-single-msg').textContent = '複製失敗';
      }
    };
    if ($('#student-answer')) $('#student-answer').oninput = (e) => { p.studentAnswer = e.target.value; save(); };
    $('#note').oninput = (e) => { p.note = e.target.value; save(); };
    if ($('#early-finish')) $('#early-finish').onclick = () => finish();
    $('#next').onclick = () => { i++; showCurrentMeta = false; i < pool.length ? render() : finish(); };
  };
  const finish = () => {
    pushSync(); // checkpoint:練習完成立即上傳
    const total = right + wrong;
    const pct = total ? Math.round((right / total) * 1000) / 10 : 0;

    // 進步的第一性原理是補不會：統計本次錯題落在哪些官方評鑑範圍
    const wrongByItem = {};
    for (const wq of sessionWrong) {
      const key = wq.syllabusItem || wq.chapter || wq.subject;
      (wrongByItem[key] ||= { chapter: wq.chapter, item: key, qs: [] }).qs.push(wq);
    }
    const weakDiagnosticHtml = Object.values(wrongByItem).length ? `
      <div style="margin:14px 0;padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px">
        <h3 style="margin:0 0 6px;color:#b91c1c;font-size:15px">🎯 進步的第一性原理是「補不會」：本次待補強評鑑範圍</h3>
        <p class="muted" style="margin:0 0 8px;font-size:13px">別無腦刷題！以下是你剛才答錯所對應的官方評鑑內容，點擊可直接針對該範圍全部題目特訓：</p>
        ${Object.values(wrongByItem).map((g) => {
          const allInScope = DATA.questions.filter((x) => (x.syllabusItem || x.chapter || x.subject) === g.item);
          return `<div class="row" style="padding:6px 0;border-top:1px dashed #fca5a5">
            <span style="font-size:14px"><b>${esc(g.item)}</b> <span class="muted">（本次錯 ${g.qs.length} 題）</span></span>
            <button class="goto drill-scope-btn" data-scope="${esc(g.item)}" style="background:#fee2e2;color:#b91c1c;font-weight:600">特訓此範圍 (${allInScope.length} 題)</button>
          </div>`;
        }).join('')}
      </div>
    ` : '';

    view.innerHTML = `
      <section class="card">
        <h2>練習完成</h2>
        <p class="score">${pct}％</p>
        <p>這組 ${total} 題,答對 ${right}、答錯 ${wrong}</p>
        ${weakDiagnosticHtml}
        ${sessionWrong.length ? '<button class="primary" id="redo-wrong">只練這次錯的</button>' : '<p class="muted">這組全對,讚!</p>'}
        <button id="again">再練一次</button>
        <button id="back">回首頁</button>
      </section>`;
    if (sessionWrong.length) $('#redo-wrong').onclick = () => runPractice(sessionWrong.slice());
    view.querySelectorAll('.drill-scope-btn').forEach((btn) => {
      btn.onclick = () => {
        const sc = btn.dataset.scope;
        const scopePool = DATA.questions.filter((x) => (x.syllabusItem || x.chapter || x.subject) === sc);
        runPractice(shuffle(scopePool));
      };
    });
    $('#again').onclick = () => runPractice(shuffle(pool.slice()));
    $('#back').onclick = home;
  };
  render();
}

let guideActiveCat = '全部';
let guideSearchKw = '';

function guide() {
  setNav('guide');
  const cats = GUIDE_DATA.categories && GUIDE_DATA.categories.length
    ? GUIDE_DATA.categories
    : ['全部', '數值預測任務', '分類判斷任務', '非監督學習', '模型評估與陷阱', '資料處理與特徵工程'];
  const allCards = GUIDE_DATA.cards || [];

  const render = () => {
    const kw = guideSearchKw.trim().toLowerCase();
    const filtered = allCards.filter((c) => {
      if (guideActiveCat !== '全部' && c.category !== guideActiveCat) return false;
      if (!kw) return true;
      const haystack = `${c.title} ${c.subtitle || ''} ${c.chapter || ''} ${c.syllabusItem || ''} ${c.function} ${c.scenario} ${c.trap} ${(c.keywords || []).join(' ')}`.toLowerCase();
      return haystack.includes(kw);
    });

    const catTabs = cats.map((cat) => `
      <button class="guide-cat-tab ${guideActiveCat === cat ? 'on' : ''}" data-cat="${esc(cat)}">
        ${esc(cat)} ${cat === '全部' ? `(${allCards.length})` : `(${allCards.filter((x) => x.category === cat).length})`}
      </button>
    `).join('');

    const dueCardsList = getDueCards();
    const dueBannerHtml = dueCardsList.length ? `
      <div class="card review-card" style="margin-bottom:12px">
        <div class="row">
          <div>
            <h3 style="margin:0">⏳ 艾賓浩斯心智卡待複習（${dueCardsList.length} 張）</h3>
            <p class="muted" style="margin:4px 0 0">以下有心智卡排程複習時間已到，點擊卡片旁的「實戰測驗」直接驗收！</p>
          </div>
        </div>
      </div>
    ` : '';

    const cardsHtml = filtered.map((card) => {
      // 找出初級科目1匹配的真題數量
      const matchedQs = DATA.questions.filter((q) => {
        if (q.level !== '初級') return false;
        const text = `${q.question} ${q.options.join(' ')} ${q.explanation || ''} ${q.topic || ''}`.toLowerCase();
        return (card.keywords || []).some((k) => text.includes(k.toLowerCase()));
      });
      const qCount = matchedQs.length;

      const cs = store.cards?.[card.id];
      const rStatus = cs ? formatReviewDue(cs.reviewDue) : null;
      const reviewBtnText = cs?.reviewDue
        ? (rStatus?.isDue ? '⏳ 今日待複習' : `⏳ ${rStatus?.label || '已排複習'}`)
        : '＋ 加入複習曲線';
      const reviewBtnClass = cs?.reviewDue
        ? (rStatus?.isDue ? 'review-toggle-btn due card-review-btn' : 'review-toggle-btn on card-review-btn')
        : 'review-toggle-btn card-review-btn';

      return `
        <div class="guide-card" data-cid="${esc(card.id)}">
          <div class="guide-card-top">
            <div>
              <h3 class="guide-card-title">${esc(card.title)}</h3>
              ${card.syllabusItem ? `<div style="font-size:12px;color:var(--c-accent);font-weight:600;margin-top:2px">📍 評鑑範圍：${esc(card.chapter || '')} ▸ ${esc(card.syllabusItem)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span class="guide-card-cat">${esc(card.category)}</span>
              <button class="${reviewBtnClass}" data-cid="${esc(card.id)}" title="加入艾賓浩斯間隔複習">${reviewBtnText}</button>
            </div>
          </div>
          ${card.subtitle ? `<div class="guide-card-sub">${esc(card.subtitle)}</div>` : ''}
          <div class="guide-card-body">
            <div class="guide-item fun"><b>🔹 核心功能</b> ${esc(card.function)}</div>
            <div class="guide-item sce"><b>🔸 考題情境</b> ${esc(card.scenario)}</div>
            <div class="guide-item trp"><b>⚠️ 陷阱提醒</b> ${esc(card.trap)}</div>
          </div>
          <div class="guide-card-footer">
            <button class="guide-quiz-btn" data-cid="${esc(card.id)}">
              🎯 實戰測驗此觀念 ${qCount ? `(${qCount} 題)` : ''}
            </button>
            <div>
              <button class="guide-copy-btn" data-cid="${esc(card.id)}">📋 複製心智卡</button>
              <span class="muted card-sync-msg-${esc(card.id)}" style="font-size:12px;margin-left:6px"></span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    view.innerHTML = `
      <section class="card guide-header">
        <h2>初級考科一：人工智慧基礎概論 · 考點速查心智卡</h2>
        <p class="muted" style="margin:4px 0 10px;font-size:14px">
          專治「看懂名詞卻不知用來做什麼、情境題選不出來」！每張卡片皆可一鍵直通歷屆真題測驗，驗收 Active Recall 主動回憶。
        </p>
        <label style="margin:0 0 8px">
          <input id="guide-kw-in" placeholder="搜尋專有名詞、演算法或指標，例如：迴歸、AUC、過擬合、混淆矩陣..." value="${esc(guideSearchKw)}">
        </label>
        <div class="guide-tabs">${catTabs}</div>
      </section>
      ${dueBannerHtml}
      <div id="guide-list">${cardsHtml || '<section class="card"><p class="muted">沒有符合搜尋條件的考點心智卡。</p></section>'}</div>
    `;

    // 綁定搜尋輸入
    const kwInput = $('#guide-kw-in');
    if (kwInput) {
      kwInput.oninput = (e) => {
        guideSearchKw = e.target.value;
        render();
        const el = $('#guide-kw-in');
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      };
    }

    // 綁定類別切換
    view.querySelectorAll('.guide-cat-tab').forEach((btn) => {
      btn.onclick = () => {
        guideActiveCat = btn.dataset.cat;
        render();
      };
    });

    // 綁定複習排程切換按鈕
    view.querySelectorAll('.card-review-btn').forEach((btn) => {
      btn.onclick = () => {
        const cid = btn.dataset.cid;
        store.cards ||= {};
        const cs = store.cards[cid] ||= {};
        if (cs.reviewDue) {
          delete cs.reviewDue;
          delete cs.reviewStage;
        } else {
          const next = calcNextReview(0, true);
          cs.reviewStage = next.stage;
          cs.reviewDue = next.due;
        }
        save();
        render();
      };
    });

    // 綁定實戰測驗按鈕
    view.querySelectorAll('.guide-quiz-btn').forEach((btn) => {
      btn.onclick = () => {
        const cid = btn.dataset.cid;
        const card = allCards.find((c) => c.id === cid);
        if (!card) return;
        const matchedQs = DATA.questions.filter((q) => {
          if (q.level !== '初級') return false;
          const text = `${q.question} ${q.options.join(' ')} ${q.explanation || ''} ${q.topic || ''}`.toLowerCase();
          return (card.keywords || []).some((k) => text.includes(k.toLowerCase()));
        });
        if (matchedQs.length) {
          runPractice(shuffle(matchedQs));
        } else {
          alert('目前題庫中暫無完全匹配此關鍵字的初級題目');
        }
      };
    });

    // 綁定複製 Notion Markdown
    view.querySelectorAll('.guide-copy-btn').forEach((btn) => {
      btn.onclick = async () => {
        const cid = btn.dataset.cid;
        const card = allCards.find((c) => c.id === cid);
        if (!card) return;
        const mdText = cardToNotionMarkdown(card);
        const msgEl = view.querySelector(`.card-sync-msg-${cid}`);
        try {
          await navigator.clipboard.writeText(mdText);
          if (msgEl) msgEl.textContent = '✓ 已複製！可直接貼上 Notion';
        } catch {
          if (msgEl) msgEl.textContent = '複製失敗';
        }
      };
    });
  };

  render();
}

function mockSetup() {
  setNav('mock');
  const allPapers = papers();
  const bPapers = allPapers.filter((p) => p.startsWith('初級'));
  const mPapers = allPapers.filter((p) => p.startsWith('中級'));
  let mockLv = prefLevel();
  if (mockLv !== '初級' && mockLv !== '中級') mockLv = '初級';

  const lim = DATA.meta.defaultTimeLimitMin || 60;
  const sess = store.mockSession;
  const answeredInSess = sess ? (sess.answers || []).filter((a) => a !== null).length : 0;
  const resumeBanner = (sess && sess.poolIds && sess.poolIds.length) ? `
    <div style="margin-bottom:14px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px">
      <div style="font-weight:700;color:#1e40af;margin-bottom:4px;display:flex;align-items:center;gap:6px">
        <span>📌 偵測到上次做到一半的模擬考</span>
      </div>
      <div style="font-size:13px;color:#2563eb;margin-bottom:8px">
        試卷：<b>${esc(sess.paperName)}</b>（已作答 ${answeredInSess} / ${sess.poolIds.length} 題，剩餘約 ${Math.max(1, Math.round(sess.remaining / 60))} 分鐘）
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="primary" id="mk-resume" style="margin:0;padding:6px 14px">▶ 繼續作答第 ${sess.i + 1} 題</button>
        <button id="mk-discard" style="margin:0;padding:6px 14px;background:#fff;border:1px solid #cbd5e1;color:#64748b">放棄並重新開始</button>
      </div>
    </div>
  ` : '';

  view.innerHTML = `
    <section class="card">
      <h2>模擬考模式</h2>
      <p class="muted">整份計時作答，交卷前不顯示答案。練臨場與時間分配。支援做到一半隨時暫存離開或提前交卷。</p>
      ${resumeBanner}
      <div class="level-tabs" id="mk-level-tabs">
        <button class="level-tab ${mockLv === '初級' ? 'on' : ''}" data-lv="初級">初級（${bPapers.length} 卷）</button>
        <button class="level-tab ${mockLv === '中級' ? 'on' : ''}" data-lv="中級">中級（${mPapers.length} 卷）</button>
        <button class="level-tab ${mockLv === '全部' ? 'on' : ''}" data-lv="全部">全部（${allPapers.length} 卷）</button>
      </div>
      <label>試卷<select id="mk-paper"></select></label>
      <label>試卷題數
        <select id="mk-count">
          <option value="25" selected>半份試卷（25 題，做到一半剛剛好，適合短時間）</option>
          <option value="0">完整試卷（全卷約 50 題，全真模考）</option>
          <option value="15">快速精練（15 題，短時間衝刺）</option>
        </select>
      </label>
      <label>時間（分鐘）<input id="mk-min" type="number" value="${Math.round(lim / 2)}" min="1"></label>
      <button class="primary" id="mk-start">開始模擬考</button>
    </section>`;

  if ($('#mk-resume')) {
    $('#mk-resume').onclick = () => {
      const qMap = new Map(DATA.questions.map((q) => [q.id, q]));
      const pool = sess.poolIds.map((id) => qMap.get(id)).filter(Boolean);
      if (pool.length) {
        runMock(pool, Math.max(1, Math.round(sess.remaining / 60)), sess);
      } else {
        delete store.mockSession;
        save();
        mockSetup();
      }
    };
  }
  if ($('#mk-discard')) {
    $('#mk-discard').onclick = () => {
      delete store.mockSession;
      save();
      mockSetup();
    };
  }

  const updatePapers = (lv) => {
    mockLv = lv;
    view.querySelectorAll('#mk-level-tabs .level-tab').forEach((b) => b.classList.toggle('on', b.dataset.lv === lv));
    const list = lv === '初級' ? bPapers : lv === '中級' ? mPapers : allPapers;
    $('#mk-paper').innerHTML = list.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  };
  view.querySelectorAll('#mk-level-tabs .level-tab').forEach((b) => {
    b.onclick = () => updatePapers(b.dataset.lv);
  });
  updatePapers(mockLv);

  $('#mk-count').onchange = () => {
    const c = +$('#mk-count').value;
    if (c === 25) $('#mk-min').value = Math.max(15, Math.round(lim / 2));
    else if (c === 15) $('#mk-min').value = Math.max(10, Math.round((lim * 15) / 50));
    else $('#mk-min').value = lim;
  };

  $('#mk-start').onclick = () => {
    const paper = $('#mk-paper').value;
    let pool = DATA.questions.filter((q) => `${q.level}｜${q.round}｜${q.subject}` === paper);
    const count = +$('#mk-count').value || 0;
    const mins = +$('#mk-min').value || lim;
    if (count > 0 && count < pool.length) {
      pool = pool.slice(0, count);
    }
    runMock(pool, mins);
  };
}

function runMock(pool, mins, existingSession = null) {
  const answers = existingSession?.answers ? [...existingSession.answers] : new Array(pool.length).fill(null);
  let i = existingSession?.i != null ? Math.min(existingSession.i, pool.length - 1) : 0;
  let remaining = existingSession?.remaining != null ? existingSession.remaining : mins * 60;
  const paperName = pool[0] ? `${pool[0].level}｜${pool[0].round}｜${pool[0].subject}` : '模擬考';

  const saveSession = () => {
    store.mockSession = {
      poolIds: pool.map((q) => q.id),
      answers,
      remaining,
      i,
      paperName,
      timestamp: Date.now(),
    };
    save();
  };

  clearMockTimer();
  activeMockSessionSaver = saveSession;

  const fmt = () => `${String((remaining / 60) | 0).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  activeMockTimer = setInterval(() => {
    remaining--;
    const t = $('#timer');
    if (t) t.textContent = fmt();
    if (remaining <= 0) {
      activeMockSessionSaver = null;
      clearMockTimer();
      submit();
    }
  }, 1000);

  const render = () => {
    const q = pool[i];
    const answeredCount = answers.filter((a) => a !== null).length;
    view.innerHTML = `
      <section class="card">
        <div class="row">
          <span class="muted">${i + 1} / ${pool.length}（已作答 ${answeredCount} 題）</span>
          <span id="timer" class="timer">${fmt()}</span>
        </div>
        <p class="qmeta muted">${esc(q.subject)}</p>
        <h3>${esc(q.question)}</h3>
        ${q.image ? `<img class="qfig" src="${esc(q.image)}" alt="題目附圖" loading="lazy">` : ''}
        <div id="opts">${q.options.map((o, k) =>
          `<button class="opt ${answers[i] === k ? 'picked' : ''}" data-k="${k}">${esc(o)}</button>`).join('')}</div>
        <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
          <button id="prev" ${i === 0 ? 'disabled' : ''}>上一題</button>
          ${i + 1 < pool.length ? '<button id="next">下一題</button>' : ''}
          <button class="primary" id="submit" style="margin:0">${answeredCount < pool.length ? '提前交卷' : '交卷'}</button>
          <button id="pause-mock" style="background:#f1f5f9;color:#475569;margin:0" title="隨時保存作答進度，下次進入模擬考繼續">暫存離開（做到一半下次繼續）</button>
        </div>
      </section>`;

    // 點選項只切換 picked class,不整卡重 render(否則 #timer 被重建會閃 --:--)
    view.querySelectorAll('.opt').forEach((b) => (b.onclick = () => {
      answers[i] = +b.dataset.k;
      saveSession();
      view.querySelectorAll('.opt').forEach((x) => x.classList.toggle('picked', +x.dataset.k === answers[i]));
      const newAnswered = answers.filter((a) => a !== null).length;
      if ($('#submit')) $('#submit').textContent = newAnswered < pool.length ? '提前交卷' : '交卷';
    }));

    if ($('#prev')) $('#prev').onclick = () => { i--; saveSession(); render(); };
    if ($('#next')) $('#next').onclick = () => { i++; saveSession(); render(); };
    if ($('#submit')) $('#submit').onclick = () => {
      const ansCount = answers.filter((a) => a !== null).length;
      if (ansCount < pool.length) {
        if (!confirm(`目前共 ${pool.length} 題，你已作答 ${ansCount} 題（尚有 ${pool.length - ansCount} 題未作答）。\n確定要現在提前交卷結算成績嗎？`)) {
          return;
        }
      }
      submit();
    };
    if ($('#pause-mock')) {
      $('#pause-mock').onclick = () => {
        clearMockTimer();
        saveSession();
        alert(`已暫存目前作答進度（已答 ${answeredCount} / ${pool.length} 題，剩餘 ${Math.max(1, Math.round(remaining / 60))} 分鐘）！\n下次點進「模擬考」隨時可繼續作答。`);
        home();
      };
    }
  };

  function submit() {
    activeMockSessionSaver = null;
    clearMockTimer();
    const now = Date.now();
    // 計入進度（只把實際作答的題目計入 attempts / correct / wrong，更新時間戳確保跨裝置同步不被舊資料覆蓋）
    pool.forEach((q, idx) => {
      if (answers[idx] === null) return;
      const p = qp(q.id);
      const correct = answers[idx] === q.answer;
      p.attempts++;
      if (correct) p.correct++; else p.wrong++;
      p.lastAnsweredAt = now;
      p.updatedAt = now;
      p.box = nextBox(p.box, correct);
      logRecent(correct);
      bumpDaily(correct);
    });
    delete store.mockSession;
    save();
    pushSync(); // checkpoint:交卷立即上傳

    const r = scoreExam(pool, answers);
    const attemptedCount = answers.filter((a) => a !== null).length;
    const attemptedCorrect = pool.filter((q, idx) => answers[idx] === q.answer).length;
    const attemptedPct = attemptedCount ? Math.round((attemptedCorrect / attemptedCount) * 1000) / 10 : 0;

    const wrongQs = pool.filter((q, idx) => answers[idx] !== null && answers[idx] !== q.answer);
    const wrongByItem = {};
    for (const wq of wrongQs) {
      const key = wq.syllabusItem || wq.chapter || wq.subject;
      (wrongByItem[key] ||= { item: key, qs: [] }).qs.push(wq);
    }
    const mockDiagHtml = Object.values(wrongByItem).length ? `
      <div style="margin:14px 0;padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px">
        <h3 style="margin:0 0 6px;color:#b91c1c;font-size:15px">🎯 模考失分診斷：錯誤題目對應評鑑範圍</h3>
        ${Object.values(wrongByItem).sort((a, b) => b.qs.length - a.qs.length).map((g) => {
          const allInScope = DATA.questions.filter((x) => (x.syllabusItem || x.chapter || x.subject) === g.item);
          return `<div class="row" style="padding:6px 0;border-top:1px dashed #fca5a5">
            <span style="font-size:14px"><b>${esc(g.item)}</b> <span class="muted">（錯 ${g.qs.length} 題）</span></span>
            <button class="goto mock-drill-scope" data-scope="${esc(g.item)}" style="background:#fee2e2;color:#b91c1c;font-weight:600">特訓此範圍 (${allInScope.length} 題)</button>
          </div>`;
        }).join('')}
      </div>
    ` : '';

    view.innerHTML = `
      <section class="card">
        <h2>模擬考結果</h2>
        <p class="score">${r.percent}％</p>
        <p style="font-size:15px">
          總分：答對 ${r.correct} / ${r.total} 題（${r.percent}％）
          ${attemptedCount < pool.length ? `<br><span style="color:#0284c7;font-weight:600;font-size:14px">（已作答 ${attemptedCount} 題中答對 ${attemptedCorrect} 題，實答正確率：${attemptedPct}％）</span>` : ''}
        </p>
        ${mockDiagHtml}
        <button class="primary" id="review">${wrongQs.length ? `檢討錯題 (${wrongQs.length})` : '檢視作答'}</button>
        <button id="back">回首頁</button>
      </section>`;
    $('#back').onclick = home;
    $('#review').onclick = () => runPractice(wrongQs.length ? wrongQs : pool);
    view.querySelectorAll('.mock-drill-scope').forEach((btn) => {
      btn.onclick = () => {
        const sc = btn.dataset.scope;
        runPractice(shuffle(DATA.questions.filter((x) => (x.syllabusItem || x.chapter || x.subject) === sc)));
      };
    });
  }
  render();
}

function wrongbook() {
  setNav('wrong');
  const ids = wrongQuestionIds(DATA.questions, store.q);
  const list = ids.map((id) => DATA.questions.find((q) => q.id === id)).filter(Boolean);
  let wrongLv = prefLevel();
  if (wrongLv !== '初級' && wrongLv !== '中級') wrongLv = '全部';

  const bList = list.filter((q) => q.level === '初級');
  const mList = list.filter((q) => q.level === '中級');

  view.innerHTML = `
    <section class="card">
      <h2>錯題本 · 錯誤題目對應學習範圍</h2>
      <p class="muted">進步的第一性原理是「補不會，而不是無腦刷題」！錯題已自動對齊官方 iPAS 評鑑主題與評鑑內容（L111~L234），讓你精準定位弱點範圍並一鍵補強。同一題連續答對 ${MASTER_BOX - 1} 次即自動移出。</p>
      <div class="level-tabs" id="wr-level-tabs">
        <button class="level-tab ${wrongLv === '初級' ? 'on' : ''}" data-lv="初級">初級（${bList.length}）</button>
        <button class="level-tab ${wrongLv === '中級' ? 'on' : ''}" data-lv="中級">中級（${mList.length}）</button>
        <button class="level-tab ${wrongLv === '全部' ? 'on' : ''}" data-lv="全部">全部（${list.length}）</button>
      </div>
      <div id="wrong-container"></div>
    </section>`;

  const renderList = (lv) => {
    wrongLv = lv;
    const filtered = lv === '初級' ? bList : lv === '中級' ? mList : list;
    const container = $('#wrong-container');
    if (!container) return;
    view.querySelectorAll('#wr-level-tabs .level-tab').forEach((b) => b.classList.toggle('on', b.dataset.lv === lv));

    // 按官方評鑑主題 (chapter) ➔ 評鑑內容 (syllabusItem) 分組診斷
    const byTheme = new Map();
    for (const q of filtered) {
      const th = q.chapter || q.subject;
      const it = q.syllabusItem || th;
      if (!byTheme.has(th)) byTheme.set(th, { theme: th, subject: q.subject, items: new Map(), qs: [] });
      const tGroup = byTheme.get(th);
      tGroup.qs.push(q);
      if (!tGroup.items.has(it)) tGroup.items.set(it, []);
      tGroup.items.get(it).push(q);
    }

    const sortedThemes = [...byTheme.values()].sort((a, b) => b.qs.length - a.qs.length || a.theme.localeCompare(b.theme, 'zh-Hant'));

    const radarHtml = sortedThemes.length ? `
      <div style="margin:12px 0 18px;padding:14px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px">
        <h3 style="margin:0 0 8px;font-size:16px">🗺️ 弱點學習範圍地圖（依錯題數排序，先救失分最多的範圍！）</h3>
        ${sortedThemes.map((tg) => {
          const itemRows = [...tg.items.entries()].sort((a, b) => b[1].length - a[1].length).map(([itemName, iQs]) => {
            const fullPoolCount = DATA.questions.filter((x) => (x.syllabusItem || x.chapter || x.subject) === itemName).length;
            const hasGuideCard = (GUIDE_DATA.cards || []).some((c) => c.syllabusItem === itemName || c.chapter === tg.theme);
            return `
              <div class="row" style="padding:7px 10px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;margin-top:6px;flex-wrap:wrap;gap:6px">
                <div>
                  <span style="font-weight:600;font-size:14px;color:#1e293b">▸ ${esc(itemName)}</span>
                  <span class="review-badge due" style="margin-left:6px">錯 ${iQs.length} 題</span>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  <button class="goto wr-drill-wrong" data-item="${esc(itemName)}" style="background:#fee2e2;color:#b91c1c;font-weight:600">重練此處錯題 (${iQs.length})</button>
                  <button class="goto wr-drill-all" data-item="${esc(itemName)}" style="background:#eff6ff;color:#1d4ed8;font-weight:600">刷滿此範圍題庫 (${fullPoolCount} 題)</button>
                  ${hasGuideCard ? `<button class="goto wr-goto-guide" data-theme="${esc(tg.theme)}" style="background:#f0fdf4;color:#15803d;font-weight:600">📖 考點心智卡</button>` : ''}
                </div>
              </div>
            `;
          }).join('');

          return `
            <div style="margin-bottom:12px">
              <div class="row" style="margin-bottom:4px">
                <strong style="font-size:15px;color:var(--c-accent)">📂 ${esc(tg.theme)} <span class="muted" style="font-weight:normal;font-size:12px">（${esc(tg.subject)} · 共錯 ${tg.qs.length} 題）</span></strong>
                <button class="goto wr-drill-theme" data-theme="${esc(tg.theme)}">練此主題全部錯題 (${tg.qs.length})</button>
              </div>
              ${itemRows}
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    container.innerHTML = `
      ${filtered.length ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button class="primary" id="drill" style="margin:0">只練全部錯題（${filtered.length} 題）</button>
          <button class="notion-btn" id="notion-wrong-sync" style="margin:0">📌 錯題同步至 Notion</button>
          <button class="notion-btn alt" id="notion-wrong-exp" style="margin:0">📋 複製 Notion 格式</button>
          <span id="notion-wrong-msg" class="muted" style="font-size:12px"></span>
        </div>
        ${radarHtml}
        <h3 style="font-size:15px;margin:16px 0 8px">📋 錯題明細列表</h3>
      ` : `<p class="muted">${lv === '全部' ? '目前沒有錯題，繼續加油。' : `目前沒有${lv}錯題。`}</p>`}
      <ul class="wrong">${filtered.map((q) => `<li>
        <div><strong>[${esc(q.syllabusItem || q.chapter || q.subject)}]</strong> ${esc(q.question)}</div>
        <div class="muted" style="font-size:12px;margin-top:3px">
          ${esc(q.level)}・${esc(q.chapter || q.subject)}${q.topic ? '・考點：' + esc(q.topic) : ''}・再連對 ${Math.max(1, MASTER_BOX - (qp(q.id).box || 1))} 次就掌握
          <button class="goto wr-single-q" data-qid="${esc(q.id)}" style="margin-left:8px;padding:2px 8px;font-size:12px">單題重練</button>
        </div>
      </li>`).join('')}</ul>
    `;
    if (filtered.length && $('#drill')) {
      $('#drill').onclick = () => runPractice(shuffle(filtered));
    }
    view.querySelectorAll('.wr-drill-wrong').forEach((btn) => {
      btn.onclick = () => {
        const it = btn.dataset.item;
        runPractice(shuffle(filtered.filter((q) => (q.syllabusItem || q.chapter || q.subject) === it)));
      };
    });
    view.querySelectorAll('.wr-drill-all').forEach((btn) => {
      btn.onclick = () => {
        const it = btn.dataset.item;
        runPractice(shuffle(DATA.questions.filter((q) => (q.syllabusItem || q.chapter || q.subject) === it)));
      };
    });
    view.querySelectorAll('.wr-drill-theme').forEach((btn) => {
      btn.onclick = () => {
        const th = btn.dataset.theme;
        runPractice(shuffle(filtered.filter((q) => (q.chapter || q.subject) === th)));
      };
    });
    view.querySelectorAll('.wr-goto-guide').forEach((btn) => {
      btn.onclick = () => {
        const th = btn.dataset.theme;
        const code = th.split(' ')[0]; // e.g. L111, L113
        guideActiveCat = '全部';
        guideSearchKw = code;
        guide();
      };
    });
    view.querySelectorAll('.wr-single-q').forEach((btn) => {
      btn.onclick = () => {
        const q = DATA.questions.find((x) => x.id === btn.dataset.qid);
        if (q) runPractice([q]);
      };
    });
    if (filtered.length && $('#notion-wrong-sync')) {
      $('#notion-wrong-sync').onclick = async () => {
        const btn = $('#notion-wrong-sync');
        const msg = $('#notion-wrong-msg');
        const { token, dbId } = getNotionConfig();
        if (!token || !dbId) { msg.textContent = '請先在「設定」設定 Notion Token 與 Database ID'; return; }
        btn.disabled = true;
        let count = 0;
        for (let idx = 0; idx < filtered.length; idx++) {
          msg.textContent = `同步中 (${idx + 1}/${filtered.length})…`;
          try {
            await syncQuestionToNotion(filtered[idx], qp(filtered[idx].id));
            qp(filtered[idx].id).notionSyncedAt = Date.now();
            count++;
          } catch (e) { console.warn(e); }
        }
        save();
        btn.disabled = false;
        msg.textContent = `✓ 已成功同步 ${count} 題錯題至 Notion！`;
      };
    }
    if (filtered.length && $('#notion-wrong-exp')) {
      $('#notion-wrong-exp').onclick = async () => {
        const text = toNotionMarkdown(filtered, store.q, `iPAS 錯題複習（${lv}）`);
        try {
          await navigator.clipboard.writeText(text);
          $('#notion-wrong-msg').textContent = '✓ 已複製全部錯題之 Notion Toggle 格式！';
        } catch {
          $('#notion-wrong-msg').textContent = '複製失敗';
        }
      };
    }
  };

  view.querySelectorAll('#wr-level-tabs .level-tab').forEach((b) => {
    b.onclick = () => renderList(b.dataset.lv);
  });
  renderList(wrongLv);
}

function notes() {
  setNav('notes');
  const items = DATA.questions.filter((q) => { const p = store.q[q.id]; return p && (p.note || p.studentAnswer || p.starred); });
  view.innerHTML = `
    <section class="card">
      <h2>我的筆記</h2>
      <p class="muted">有寫筆記、或加星 ⭐ 的題目都在這。支援一鍵匯出或同步至 Notion 資料庫進行 Active Recall 記憶！</p>
      ${items.length
        ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
             <button id="exp-notes">匯出筆記（Markdown）</button>
             <button id="exp-notion-md">匯出 Notion Active Recall 格式</button>
             <button class="notion-btn" id="notion-sync-notes">📌 同步星標筆記至 Notion</button>
             <span id="notion-notes-msg" class="muted" style="font-size:12px;width:100%;margin-top:2px"></span>
           </div>`
        : '<p>還沒有筆記或星標題。練習時在題目下方寫筆記、或點 ☆ 加星,就會出現在這。</p>'}
      ${items.map((q) => {
        const p = qp(q.id);
        return `<div class="note-item">
          <div class="row"><span class="muted">${p.starred ? '⭐ ' : ''}${esc(q.subject)}</span>
            <span>
              <button class="notion-btn" style="padding:4px 9px!important;font-size:12px!important" data-id="${esc(q.id)}">📌 存入 Notion</button>
              <button class="goto" data-id="${esc(q.id)}">前往該題</button>
            </span>
          </div>
          <p class="qn">${esc(q.question)}</p>
          <textarea class="note-edit" data-id="${esc(q.id)}" rows="2" placeholder="寫下你的理解或記憶點…">${esc(p.note || '')}</textarea>
        </div>`;
      }).join('')}
    </section>`;
  view.querySelectorAll('.note-edit').forEach((t) => (t.oninput = (e) => { qp(e.target.dataset.id).note = e.target.value; save(); }));
  view.querySelectorAll('.goto').forEach((b) => (b.onclick = () => { const q = DATA.questions.find((x) => x.id === b.dataset.id); if (q) runPractice([q]); }));
  view.querySelectorAll('.note-item .notion-btn').forEach((b) => (b.onclick = async () => {
    const q = DATA.questions.find((x) => x.id === b.dataset.id);
    if (!q) return;
    const { token, dbId } = getNotionConfig();
    if (!token || !dbId) { alert('請先至「設定」設定 Notion Token 與 Database ID'); return; }
    b.disabled = true; b.textContent = '同步中…';
    try {
      await syncQuestionToNotion(q, qp(q.id));
      qp(q.id).notionSyncedAt = Date.now(); save();
      b.textContent = '✓ 已存入';
    } catch (err) {
      b.disabled = false; b.textContent = '📌 存入 Notion';
      alert('同步失敗：' + err.message);
    }
  }));
  if (items.length) {
    $('#exp-notes').onclick = () => download('ipas-notes.md', toMarkdown(DATA.questions, store.q), 'text/markdown');
    $('#exp-notion-md').onclick = () => download('ipas-notion-recall.md', toNotionMarkdown(DATA.questions, store.q), 'text/markdown');
    $('#notion-sync-notes').onclick = async () => {
      const btn = $('#notion-sync-notes');
      const msg = $('#notion-notes-msg');
      const { token, dbId } = getNotionConfig();
      if (!token || !dbId) { msg.textContent = '請先至「設定」設定 Notion Token 與 Database ID'; return; }
      btn.disabled = true;
      let okCount = 0;
      for (let idx = 0; idx < items.length; idx++) {
        msg.textContent = `正在同步至 Notion (${idx + 1}/${items.length})…`;
        try {
          await syncQuestionToNotion(items[idx], qp(items[idx].id));
          qp(items[idx].id).notionSyncedAt = Date.now();
          okCount++;
        } catch (err) {
          console.warn('Sync item failed:', err);
        }
      }
      save();
      btn.disabled = false;
      msg.textContent = `✓ 已成功同步 ${okCount} / ${items.length} 題至 Notion 資料庫！`;
    };
  }
}

function stats() {
  setNav('stats');
  let stLv = prefLevel();
  if (stLv !== '初級' && stLv !== '中級') stLv = '全部';

  view.innerHTML = `
    <section class="card">
      <h2>學習統計</h2>
      <div class="level-tabs" id="st-level-tabs">
        <button class="level-tab ${stLv === '初級' ? 'on' : ''}" data-lv="初級">初級</button>
        <button class="level-tab ${stLv === '中級' ? 'on' : ''}" data-lv="中級">中級</button>
        <button class="level-tab ${stLv === '全部' ? 'on' : ''}" data-lv="全部">全部</button>
      </div>
      <div id="stats-body"></div>
    </section>`;

  const renderStats = (lv) => {
    stLv = lv;
    view.querySelectorAll('#st-level-tabs .level-tab').forEach((b) => b.classList.toggle('on', b.dataset.lv === lv));
    const targetQs = lv === '全部' ? DATA.questions : DATA.questions.filter((q) => q.level === lv);
    const s = progressStats(targetQs, store.q);
    const cover = s.total ? Math.round((s.practiced / s.total) * 1000) / 10 : 0;
    const rec = store.recent || [];
    const recAcc = rec.length ? Math.round((rec.reduce((a, b) => a + b, 0) / rec.length) * 1000) / 10 : null;
    // 各章節（評鑑主題）與評鑑內容（細項）正確率與掌握度
    const byCh = new Map();
    const byItem = new Map();
    for (const q of targetQs) {
      const k = rangeKey(q);
      const ik = q.syllabusItem || k;
      const p = store.q[q.id] || {};
      const isWrongNow = (p.wrong || 0) > 0 && !isMastered(p.box);

      const c = byCh.get(k) || { key: k, total: 0, attempts: 0, correct: 0, mastered: 0, wrongNow: 0 };
      c.total++; c.attempts += p.attempts || 0; c.correct += p.correct || 0;
      if (isMastered(p.box)) c.mastered++;
      if (isWrongNow) c.wrongNow++;
      byCh.set(k, c);

      const ic = byItem.get(ik) || { key: ik, theme: k, total: 0, attempts: 0, correct: 0, mastered: 0, wrongNow: 0 };
      ic.total++; ic.attempts += p.attempts || 0; ic.correct += p.correct || 0;
      if (isMastered(p.box)) ic.mastered++;
      if (isWrongNow) ic.wrongNow++;
      byItem.set(ik, ic);
    }
    const chRows = [...byCh.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh-Hant')).map((x) =>
      `<tr>
        <td><b>${esc(x.key)}</b></td>
        <td>${x.attempts ? Math.round((x.correct / x.attempts) * 1000) / 10 + '％' : '—'}</td>
        <td>${x.wrongNow ? `<span style="color:var(--c-bad);font-weight:700">${x.wrongNow} 題</span>` : '0'}</td>
        <td>${x.mastered}/${x.total}</td>
        <td><button class="goto st-drill-ch" data-ch="${esc(x.key)}" style="padding:3px 8px;font-size:12px">特訓</button></td>
      </tr>`).join('');

    const itemRows = [...byItem.values()].sort((a, b) => b.wrongNow - a.wrongNow || a.key.localeCompare(b.key, 'zh-Hant')).map((x) =>
      `<tr>
        <td>${esc(x.key)}</td>
        <td>${x.attempts ? Math.round((x.correct / x.attempts) * 1000) / 10 + '％' : '—'}</td>
        <td>${x.wrongNow ? `<span style="color:var(--c-bad);font-weight:700">${x.wrongNow} 題</span>` : '0'}</td>
        <td>${x.mastered}/${x.total}</td>
        <td><button class="goto st-drill-item" data-item="${esc(x.key)}" style="padding:3px 8px;font-size:12px">特訓</button></td>
      </tr>`).join('');

    // 成就徽章
    const strk = liveStreak();
    const badges = [
      { on: s.practiced >= 50, t: '練習 50 題' },
      { on: s.practiced >= 200, t: '練習 200 題' },
      { on: s.practiced >= s.total && s.total > 0, t: '全部練過' },
      { on: strk >= 3, t: '連續 3 天' },
      { on: strk >= 7, t: '連續 7 天' },
      { on: strk >= 30, t: '連續 30 天' },
      { on: recAcc != null && recAcc >= 80, t: '近期 80% 命中' },
      { on: [...byCh.values()].some((c) => c.total > 0 && c.mastered === c.total), t: '某範圍全掌握' },
    ];
    const badgeHtml = badges.map((b) => `<span class="badge ${b.on ? '' : 'lock'}">${b.on ? '✓ ' : ''}${b.t}</span>`).join('');
    // 最近 14 天題數趨勢
    const days14 = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(today() + 'T00:00:00'); d.setDate(d.getDate() - i); days14.push(ymd(d)); }
    const hist = store.history || {};
    const maxA = Math.max(1, ...days14.map((d) => (hist[d] && hist[d].a) || 0));
    const bars = days14.map((d) => {
      const a = (hist[d] && hist[d].a) || 0;
      const h = a ? Math.max(3, Math.round((a / maxA) * 56)) : 0;
      return `<div class="tcol" title="${d}：${a} 題"><span class="tnum">${a || ''}</span><div class="bar" style="height:${h}px"></div></div>`;
    }).join('');

    $('#stats-body').innerHTML = `
      <div class="grid">
        <div><b>${cover}％</b><span>涵蓋率（練過 ${s.practiced}/${s.total}）</span></div>
        <div><b>${recAcc == null ? '—' : recAcc + '％'}</b><span>近期正確率（最近 ${rec.length}）</span></div>
        <div><b>${s.wrongNow}</b><span>目前錯題</span></div>
        <div><b>${s.mastered}</b><span>已掌握</span></div>
      </div>
      <p class="muted" style="font-size:13px">「掌握」= 同一題連續答對 2 次。考試的第一性原理是「得分，而不是全部讀完」，優先點擊下方錯題最多的評鑑範圍進行特訓！</p>
      <h3>成就</h3>
      <div class="badges">${badgeHtml}</div>
      <h3>最近 14 天題數</h3>
      <div class="trend">${bars}</div>
      <div class="trend-lab"><span>${days14[0].slice(5)}</span><span>今天</span></div>
      <h3>官方評鑑主題掌握度（${esc(lv)}）</h3>
      <table>
        <tr><th>評鑑主題</th><th>正確率</th><th>待補錯題</th><th>掌握</th><th>行動</th></tr>
        ${chRows}
      </table>
      <h3 style="margin-top:18px">官方評鑑內容細項診斷（${esc(lv)} · 依待補錯題排序）</h3>
      <table>
        <tr><th>評鑑內容細項</th><th>正確率</th><th>待補錯題</th><th>掌握</th><th>行動</th></tr>
        ${itemRows}
      </table>
    `;

    view.querySelectorAll('.st-drill-ch').forEach((btn) => {
      btn.onclick = () => {
        const ch = btn.dataset.ch;
        const pool = targetQs.filter((q) => rangeKey(q) === ch)
          .map((q) => ({ q, pr: reviewPriority(store.q[q.id]), r: Math.random() }))
          .sort((a, b) => a.pr - b.pr || a.r - b.r).map((x) => x.q);
        runPractice(pool);
      };
    });
    view.querySelectorAll('.st-drill-item').forEach((btn) => {
      btn.onclick = () => {
        const it = btn.dataset.item;
        const pool = targetQs.filter((q) => (q.syllabusItem || rangeKey(q)) === it)
          .map((q) => ({ q, pr: reviewPriority(store.q[q.id]), r: Math.random() }))
          .sort((a, b) => a.pr - b.pr || a.r - b.r).map((x) => x.q);
        runPractice(pool);
      };
    });
  };

  view.querySelectorAll('#st-level-tabs .level-tab').forEach((b) => {
    b.onclick = () => renderStats(b.dataset.lv);
  });
  renderStats(stLv);
}

// 官方考試資訊小區塊:及格標準(穩定)+ 各級下次考試日期一鍵填入(非強制,初級中級日期不同)
function examInfoHtml() {
  if (!EXAMINFO) return '';
  const t = today();
  const next = (arr) => (arr || []).filter((d) => d >= t).sort()[0];
  const picks = Object.entries(EXAMINFO.exams || {})
    .map(([lv, arr]) => { const d = next(arr); return d ? `<button class="exam-pick" data-d="${d}">下次${esc(lv)} ${d}</button>` : ''; })
    .join('');
  return `<div class="guide" style="white-space:normal">
    ${EXAMINFO.pass ? `<p style="margin:0 0 6px">${esc(EXAMINFO.pass)}</p>` : ''}
    ${picks ? `<div style="margin-bottom:6px">一鍵設為倒數日期(初級/中級日期不同,自己選):<br>${picks}</div>` : ''}
    <a href="https://ipd.nat.gov.tw/ipas/certification/AIAP/exam-info" target="_blank" rel="noopener">官方考試資訊 ↗</a>
  </div>`;
}

function settings() {
  setNav('settings');
  if (SYNC_URL) pushSync(); // 打開設定頁就把最新進度上傳，確保拿碼去別台時雲端已是最新
  const remHour = (store.settings && store.settings.reminderHour) || 20;
  view.innerHTML = `
    <section class="card">
      <h2>設定</h2>
      <h3>安裝成 App</h3>
      <p class="muted">裝起來有 App icon、可全螢幕、離線也能刷。</p>
      <button id="set-install">安裝</button>
      <span id="set-install-msg" class="muted"></span>

      <h3>學習目標</h3>
      <label>目標考試級別
        <select id="set-level">
          <option value="初級" ${prefLevel() === '初級' ? 'selected' : ''}>初級（AI 應用規劃師 初級・2 科目）</option>
          <option value="中級" ${prefLevel() === '中級' ? 'selected' : ''}>中級（AI 應用規劃師 中級・3 科目）</option>
          <option value="全部" ${prefLevel() === '全部' ? 'selected' : ''}>全部（初級 + 中級混合）</option>
        </select>
      </label>
      <label>每日目標題數
        <input id="set-goal" type="number" min="1" max="${DATA.questions.length || 890}" value="${dailyGoal()}">
      </label>
      <label>考試日期（首頁倒數用）
        <input id="set-exam" type="date" value="${(store.settings && store.settings.examDate) || ''}">
      </label>
      ${examInfoHtml()}

      <h3>每日提醒（推播）</h3>
      <p class="muted">到設定時間若今天還沒練，會推播提醒你刷題。iPhone 需先把本站「加到主畫面」，並從安裝後的 App 開啟才收得到。</p>
      <label>提醒時間
        <select id="rem-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === remHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
      </label>
      <button id="rem-toggle">${pushSupported() ? '載入中…' : '此瀏覽器不支援推播'}</button>
      <button id="rem-test">傳測試通知</button>
      <span id="rem-msg" class="muted"></span>

      <h3>同步碼</h3>
      <p class="muted">${SYNC_URL
        ? '平常背景自動同步（每隔幾秒、切走 App 時、打開本頁時都會上傳）。換新裝置時：先在舊裝置打開這頁（會上傳），再到新裝置輸入這組碼。'
        : '雲端同步尚未啟用（需在 app.js 填入 Worker 網址）。目前可用下方「匯出/匯入」轉移。'}</p>
      <p class="code" id="code">${esc(store.syncCode)}</p>
      <label>在新裝置輸入既有同步碼
        <input id="code-in" placeholder="例如 fox-river-82">
      </label>
      <button id="code-set">套用此碼</button>
      ${SYNC_URL ? '<button id="sync-now">立即同步</button>' : ''}
      <span id="sync-msg" class="muted"></span>

      <h3>Notion 記憶資料庫同步</h3>
      <p class="muted">將易忘關鍵字、星標題目與錯題同步至你的 Notion Database，利用 Toggle 摺疊進行 Active Recall 主動回憶！</p>
      <label>Notion Integration Token
        <input id="notion-token" type="password" placeholder="secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value="${esc(getNotionConfig().token)}">
      </label>
      <label>Notion Database ID
        <input id="notion-db" placeholder="32 字元資料庫 ID（從資料庫網址取得）" value="${esc(getNotionConfig().dbId)}">
      </label>
      <label>API Proxy 端點（選填，留空自動使用預設代理）
        <input id="notion-proxy" placeholder="/notion" value="${esc(getNotionConfig().proxy)}">
      </label>
      <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button id="notion-test-btn">連線測試</button>
        <button class="notion-btn" id="notion-sync-all-btn">⚡ 同步全部星標與錯題</button>
        <button id="exp-notion-all">匯出 Notion Toggle Markdown</button>
        <span id="notion-cfg-msg" class="muted" style="font-size:12px;width:100%;margin-top:2px"></span>
      </div>
      <div class="guide" style="margin-top:10px">
        <b>如何串接 Notion 資料庫？</b>
        <ol style="margin:4px 0 0;padding-left:18px">
          <li>至 <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener">Notion My Integrations</a> 建立 Integration，取得 Internal Secret。</li>
          <li>在 Notion 建立題庫資料庫，點右上角 <code>•••</code> → <code>Connections</code> → 連接該 Integration。</li>
          <li>複製資料庫連結中 32 碼英數字即為 Database ID（例如 notion.so/workspace/<b>a1b2c3d4...</b>?v=...）。</li>
        </ol>
      </div>

      <h3>備份 / 轉移</h3>
      <button id="exp">匯出進度（JSON）</button>
      <button id="imp-btn">匯入進度（JSON）</button>
      <input id="imp" type="file" accept="application/json" hidden>
      <button id="exp-md">匯出筆記（Markdown）</button>

      <h3>重設統計</h3>
      <p class="muted" style="font-size:13px">把作答統計歸零、重新練到 100%,但<strong>保留你的筆記與星標</strong>。</p>
      <button id="reset-stats">重設統計(保留筆記與星標)</button>

      <h3 class="danger">重設</h3>
      <button class="danger" id="reset">清除本機所有進度</button>
    </section>`;
  const insBtn = $('#set-install'), insMsg = $('#set-install-msg');
  if (insBtn) {
    if (isStandalone()) { insBtn.textContent = '已安裝 ✓'; insBtn.disabled = true; }
    else if (deferredInstall) {
      insBtn.onclick = async () => {
        deferredInstall.prompt();
        const c = await deferredInstall.userChoice.catch(() => ({}));
        if (c && c.outcome === 'accepted') { insBtn.textContent = '已安裝 ✓'; insBtn.disabled = true; dismissInstallBar(); }
        deferredInstall = null;
      };
    } else {
      insBtn.disabled = true;
      insBtn.textContent = '由瀏覽器選單安裝';
      insMsg.textContent = /iphone|ipad|ipod/i.test(navigator.userAgent)
        ? '（iPhone:Safari 分享鈕 → 加入主畫面）'
        : '（Chrome ⋮ 選單 → 安裝應用程式 / 加到主畫面）';
    }
  }
  if ($('#set-level')) $('#set-level').onchange = (e) => {
    store.settings ||= {};
    store.settings.prefLevel = e.target.value;
    save();
  };
  $('#set-goal').onchange = (e) => { store.settings ||= {}; store.settings.dailyGoal = Math.max(1, +e.target.value || 20); save(); };
  $('#set-exam').onchange = (e) => { store.settings ||= {}; store.settings.examDate = e.target.value; save(); };
  view.querySelectorAll('.exam-pick').forEach((b) => (b.onclick = () => {
    store.settings ||= {}; store.settings.examDate = b.dataset.d; save();
    $('#set-exam').value = b.dataset.d;
  }));
  if ($('#rem-hour')) $('#rem-hour').onchange = async (e) => {
    store.settings ||= {}; store.settings.reminderHour = +e.target.value; save();
    if (await pushIsOn()) { await enablePush(+e.target.value); $('#rem-msg').textContent = '提醒時間已更新'; }
  };
  if (pushSupported() && $('#rem-toggle')) {
    const btn = $('#rem-toggle');
    pushIsOn().then((on) => { btn.textContent = on ? '關閉提醒' : '開啟提醒'; });
    btn.onclick = async () => {
      btn.disabled = true; $('#rem-msg').textContent = '處理中…';
      try {
        if (await pushIsOn()) { await disablePush(); btn.textContent = '開啟提醒'; $('#rem-msg').textContent = '已關閉提醒'; }
        else {
          const r = await enablePush((store.settings && store.settings.reminderHour) || 20);
          if (r.ok) { btn.textContent = '關閉提醒'; $('#rem-msg').textContent = '已開啟，每天到點提醒'; }
          else { $('#rem-msg').textContent = '開啟失敗：' + (r.reason || '請稍後再試'); }
        }
      } catch { $('#rem-msg').textContent = '發生錯誤，請稍後再試'; }
      btn.disabled = false;
    };
  }
  if ($('#rem-test')) $('#rem-test').onclick = async () => {
    $('#rem-msg').textContent = '傳送測試中…';
    try {
      const r = await fetch(`${SYNC_URL}/push/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: store.syncCode }) });
      const j = await r.json().catch(() => ({}));
      $('#rem-msg').textContent = r.ok ? '已傳送，看通知有沒有跳出' : (j.error === 'not_subscribed' ? '請先「開啟提醒」' : '失敗：' + (j.error || r.status));
    } catch { $('#rem-msg').textContent = '傳送失敗'; }
  };
  $('#code-set').onclick = async () => {
    const v = $('#code-in').value.trim();
    if (!v) return;
    store.syncCode = v;
    store.updatedAt = 0; // 讓開啟時的 pull 一定採用雲端那份
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    if (SYNC_URL) await pullSync();
    settings();
  };
  if ($('#sync-now')) $('#sync-now').onclick = async () => {
    $('#sync-msg').textContent = '同步中…';
    const pulled = await pullSync();
    const pushed = await pushSync();
    $('#sync-msg').textContent = pushed || pulled ? '已同步' : '同步失敗（檢查網路或同步碼）';
    if (pulled) setTimeout(settings, 600);
  };
  if ($('#notion-token')) $('#notion-token').onchange = (e) => {
    localStorage.setItem('ipas_notion_token', e.target.value.trim());
    if (store.settings?.notionToken) delete store.settings.notionToken;
    save();
  };
  if ($('#notion-db')) $('#notion-db').onchange = (e) => {
    localStorage.setItem('ipas_notion_db_id', e.target.value.trim());
    if (store.settings?.notionDbId) delete store.settings.notionDbId;
    save();
  };
  if ($('#notion-proxy')) $('#notion-proxy').onchange = (e) => {
    localStorage.setItem('ipas_notion_proxy', e.target.value.trim());
    if (store.settings?.notionProxy) delete store.settings.notionProxy;
    save();
  };
  if ($('#notion-test-btn')) $('#notion-test-btn').onclick = async () => {
    const msg = $('#notion-cfg-msg');
    msg.textContent = '測試連線中…';
    try {
      cachedDbSchema = null;
      const db = await fetchDbSchema();
      const title = db.title?.[0]?.plain_text || '資料庫';
      msg.textContent = `✓ 連線成功！已連接 Notion 資料庫「${title}」`;
    } catch (err) {
      msg.textContent = `連線失敗：${err.message}`;
    }
  };
  if ($('#notion-sync-all-btn')) $('#notion-sync-all-btn').onclick = async () => {
    const btn = $('#notion-sync-all-btn');
    const msg = $('#notion-cfg-msg');
    const { token, dbId } = getNotionConfig();
    if (!token || !dbId) { msg.textContent = '請先填寫 Token 與 Database ID'; return; }
    btn.disabled = true;
    const targetQs = DATA.questions.filter((q) => {
      const p = store.q[q.id];
      return p && (p.starred || p.note || p.wrong > 0);
    });
    if (!targetQs.length) {
      btn.disabled = false;
      msg.textContent = '目前沒有星標、筆記或錯題需要同步';
      return;
    }
    let ok = 0;
    for (let idx = 0; idx < targetQs.length; idx++) {
      msg.textContent = `正在同步 (${idx + 1}/${targetQs.length})…`;
      try {
        await syncQuestionToNotion(targetQs[idx], qp(targetQs[idx].id));
        qp(targetQs[idx].id).notionSyncedAt = Date.now();
        ok++;
      } catch (e) { console.warn(e); }
    }
    save();
    btn.disabled = false;
    msg.textContent = `✓ 已成功同步 ${ok} / ${targetQs.length} 題至 Notion！`;
  };
  if ($('#exp-notion-all')) $('#exp-notion-all').onclick = () => {
    download('ipas-notion-recall.md', toNotionMarkdown(DATA.questions, store.q), 'text/markdown');
  };
  $('#exp').onclick = () => download('ipas-progress.json', JSON.stringify(store, null, 2), 'application/json');
  $('#exp-md').onclick = () => download('ipas-notes.md', toMarkdown(DATA.questions, store.q), 'text/markdown');
  $('#imp-btn').onclick = () => $('#imp').click();
  $('#imp').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (s && s.q) { store = mergeStores(store, s); save(); alert('已匯入並合併進度。'); home(); }
      else alert('檔案格式不符。');
    } catch { alert('讀取失敗。'); }
  };
  $('#reset').onclick = async () => {
    if (!confirm('確定清除本機所有作答進度與筆記？')) return;
    store = { v: 1, syncCode: makeCode(), codeFresh: true, q: {}, cards: {}, history: {}, recent: [] };
    await ensureFreshCode(); // 新碼先查重,再 save(save 會標 dirty 上傳)
    save(); settings();
  };
  $('#reset-stats').onclick = () => {
    if (!confirm('重設統計?掌握度、正確率、錯題本、打卡、趨勢都歸零;保留筆記、星標與設定。')) return;
    for (const id in store.q) {
      const p = store.q[id];
      if (p.note || p.starred) store.q[id] = { box: 1, attempts: 0, correct: 0, wrong: 0, note: p.note || '', starred: !!p.starred };
      else delete store.q[id];
    }
    store.recent = []; store.history = {}; store.streak = { count: 0, lastDate: '' }; store.daily = null;
    save(); settings();
  };
}

// 從 UA 粗略判斷裝置/瀏覽器,給「意見回饋」表單預填(僅 OS + 瀏覽器名,不含版本)
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '其他';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Version\/[\d.]+.*Safari/.test(ua) ? 'Safari' : '瀏覽器';
  return `${os} · ${br}`;
}

const ROUTES = { home, guide, mock: mockSetup, wrong: wrongbook, notes, stats, settings };

// ---- boot ----
async function boot() {
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => ROUTES[b.dataset.v]()));
  // 「意見回饋」連結自動帶入裝置/瀏覽器(GitHub issue form 以 &env= 預填同名欄位)
  const fbLink = document.getElementById('fb-link');
  if (fbLink) fbLink.href += `&env=${encodeURIComponent(deviceLabel())}`;
  if (isStandalone() || installBarOff()) { const b = document.getElementById('installbar'); if (b) b.hidden = true; }
  const ib = document.getElementById('install-btn');
  if (ib) ib.onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    dismissInstallBar();
  };
  const ix = document.getElementById('install-x');
  if (ix) ix.onclick = dismissInstallBar;
  try {
    DATA = await (await fetch('questions.json')).json();
  } catch {
    view.innerHTML = `<section class="card"><p class="bad">載入 questions.json 失敗。請用本機伺服器開啟（例如 <code>node server.mjs</code>）。</p></section>`;
    return;
  }
  try { CONCEPTS = ((await (await fetch('concepts.json')).json()).cards) || []; } catch { CONCEPTS = []; }
  try { GUIDE_DATA = await (await fetch('guide-cards.json')).json(); } catch { GUIDE_DATA = { categories: [], cards: [] }; }
  try { EXAMINFO = await (await fetch('exam-dates.json')).json(); } catch { EXAMINFO = null; }
  if (DATA.meta?.title) $('#title').textContent = DATA.meta.title;
  if (DATA.meta?.note) { const n = $('#banner'); n.textContent = DATA.meta.note; n.hidden = false; }
  await pullLocalDisk(); // 優先從本機硬碟 local-progress.json 救回或合併進度（防瀏覽器重整/清除快取遺失）
  localStorage.setItem(STORE_KEY, JSON.stringify(store)); // 落地可能新生成的 syncCode(不動 updatedAt)
  await ensureFreshCode(); // 全新自動碼先查重(要在 pull 之前,否則撞碼會拉到陌生人的進度)
  if (SYNC_URL) await pullSync(); // 開啟先拉雲端，並用 mergeStores 智慧合併，絕不覆蓋掉今日進度
  // checkpoint:切走/關頁/重整前，先儲存最新模考剩餘秒數與作答，再 flush 本機與雲端
  const flushLatestStateBeforeExit = () => {
    if (activeMockSessionSaver) {
      try { activeMockSessionSaver(); } catch {}
    }
    saveLocalDisk();
    pushSync({ keepalive: true });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushLatestStateBeforeExit();
  });
  window.addEventListener('pagehide', flushLatestStateBeforeExit);
  window.addEventListener('beforeunload', flushLatestStateBeforeExit);
  home();
}
boot();
