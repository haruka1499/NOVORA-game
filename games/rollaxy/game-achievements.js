'use strict';

// ============================================================
// ころころ宇宙 — game-achievements.js
// 実績システム（ロジック・UI）
//
// 実績の名前・レア度・アイコンを変更したい場合は
// achievement-data.js を編集してください。このファイルは触らなくて OK。
// ============================================================

// ACH_RARITY / ACH_CATS は achievement-data.js で定義済み（先にロードされる）

// フラットマップ（ID検索用）
const _achById = new Map();
for (const cat of ACH_CATS) for (const it of cat.items) _achById.set(it.id, it);

// ── 永続化 ──
function _loadAch() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.ACH) || '[]')); }
  catch (_) { return new Set(); }
}
function _saveAch() {
  try { localStorage.setItem(STORAGE_KEYS.ACH, JSON.stringify([..._unlocked])); }
  catch (_) {}
}
let _unlocked = _loadAch();

// ── トースト通知キュー ──
const _toastQ = [];
let _toastBusy  = false;
let _toastTimer = null; // 現在のトーストの自動消去タイマーID（キャンセル可能）

// 現在表示中のトーストをフェードアウトして次へ進む（タップ/タイムアウト共通）
function _dismissToast() {
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  const el = document.getElementById('ach-toast');
  if (!el) { _showNextToast(); return; }
  el.classList.remove('ach-toast-in');
  el.classList.add('ach-toast-out');
  setTimeout(() => {
    el.style.display = 'none';
    el.classList.remove('ach-toast-out');
    _showNextToast();
  }, 420);
}

function _showNextToast() {
  if (!_toastQ.length) { _toastBusy = false; return; }
  _toastBusy = true;

  // ID が存在しない実績はスキップ（データ不整合対策）
  let ach = null;
  while (_toastQ.length && !ach) {
    const id = _toastQ.shift();
    ach = _achById.get(id) || null;
  }
  if (!ach) { _toastBusy = false; return; }

  const el = document.getElementById('ach-toast');
  if (!el) {
    // DOM 要素がない場合も次の要素をスキップせずキューをそのまま保持して終了
    _toastBusy = false;
    return;
  }

  const lang     = typeof currentLang !== 'undefined' ? currentLang : 'ja';
  const capL     = lang.charAt(0).toUpperCase() + lang.slice(1);
  const name     = ach[`name${capL}`] || ach.nameJa;
  const cond     = ach[`cond${capL}`] || ach.condJa || null;
  const r        = ACH_RARITY[ach.rarity];
  const label    = typeof T !== 'undefined' ? T('achNewUnlock') : '実績解除！';
  const queueRem = _toastQ.length; // このトーストの後に残っている件数

  el.innerHTML =
    `<div class="ach-toast-title">${label}</div>` +
    `<div class="ach-toast-name">${name}</div>` +
    (cond ? `<div class="ach-toast-sub">${cond}</div>` : `<div class="ach-toast-sub">${name}</div>`) +
    (queueRem > 0 ? `<div class="ach-toast-queue">+${queueRem}</div>` : '');

  if (ach.rarity === 'secret') {
    el.classList.add('ach-rainbow-border');
    el.style.borderColor = '';
  } else {
    el.classList.remove('ach-rainbow-border');
    el.style.borderColor = r.border;
  }

  el.style.display = 'flex';
  el.classList.remove('ach-toast-out');
  void el.offsetWidth;
  el.classList.add('ach-toast-in');
  playNotificationSound();

  // キューが3件以上残っている場合は表示時間を短縮
  const duration = queueRem >= 3 ? 2500 : 4500;
  _toastTimer = setTimeout(_dismissToast, duration);
}

// ── サーバー同期 ──

// ページ読み込み時: サーバーの解除済み一覧を取得して localStorage とマージ
// トースト通知は出さない（すでに知っている実績なので）
async function _syncFromServer() {
  const pid = typeof getPlayerId === 'function' ? getPlayerId() : null;
  if (!pid) return;
  try {
    const res = await fetch(`/api/rollaxy/achievements?pid=${encodeURIComponent(pid)}`);
    if (!res.ok) return;
    const { ids } = await res.json();
    if (!Array.isArray(ids)) return;
    let changed = false;
    for (const id of ids) {
      if (!_unlocked.has(id)) { _unlocked.add(id); changed = true; }
    }
    if (changed) _saveAch();
  } catch (_) {}
}

// 実績解除時: バックグラウンドでサーバーに送信
async function _syncToServer(id) {
  const pid = typeof getPlayerId === 'function' ? getPlayerId() : null;
  if (!pid) return;
  try {
    await fetch('/api/rollaxy/achievements/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: pid, ach_id: id }),
    });
  } catch (_) {}
}

// ── 解除（外部から直接呼ばない） ──
function _unlockAch(id) {
  if (_unlocked.has(id)) return;
  _unlocked.add(id);
  _saveAch();
  document.dispatchEvent(new CustomEvent('ach_unlocked', { detail: { id } }));
  _syncToServer(id); // バックグラウンドでサーバーに記録（失敗しても続行）
  _toastQ.push(id);
  if (!_toastBusy) _showNextToast();
}

// ── ゲームから呼ばれるチェック関数 ──
// スコアが増えた直後に updateHUD() から呼ぶ
function achCheckScore(currentScore) {
  for (const it of ACH_CATS[0].items) {
    // items はスコア昇順で並んでいるので、閾値を超えない最初の要素で打ち切る
    if (currentScore >= it.scoreThreshold) _unlockAch(it.id);
    else break;
  }
}

// 合成時に flushMerges() から呼ぶ（totalMerges = 累計合成数）
function achCheckMergeCount(totalMerges) {
  const cat = ACH_CATS.find(c => c.id === 'merge');
  if (!cat) return;
  for (const it of cat.items) {
    if (totalMerges >= it.mergeThreshold) _unlockAch(it.id);
    else break;
  }
}

// 天体種別の合成実績チェック（bodyIndex = 合成された天体のインデックス, total = 累計）
function achCheckBodyMerge(bodyIndex, total) {
  const cat = ACH_CATS.find(c => c.bodyIndex === bodyIndex);
  if (!cat) return;
  for (const it of cat.items) {
    if (total >= it.mergeThreshold) _unlockAch(it.id);
    else break;
  }
}

// 累計連鎖回数チェック（total = 累計連鎖解決回数）
function achCheckTotalChains(total) {
  const cat = ACH_CATS.find(c => c.id === 'chain_total');
  if (!cat) return;
  for (const it of cat.items) {
    if (total >= it.mergeThreshold) _unlockAch(it.id);
    else break;
  }
}

// 連続連鎖ターン数チェック
function achCheckConsecutiveChain(count) {
  const cat = ACH_CATS.find(c => c.id === 'chain_consec');
  if (!cat) return;
  for (const it of cat.items) {
    if (count >= it.mergeThreshold) _unlockAch(it.id);
    else break;
  }
}

// 特定連鎖レベルの累計達成回数チェック（level=5〜15, total=累計達成回数）
// finalCount >= level のとき、level〜finalCount の各カテゴリへ呼ぶ
function achCheckChainByLevel(level, total) {
  const cat = ACH_CATS.find(c => c.id === `chain${level}`);
  if (!cat) return;
  for (const it of cat.items) {
    if (total >= it.mergeThreshold) _unlockAch(it.id);
    else break;
  }
}

// スキル使用後の連鎖チェック（finalCount = その連鎖の最終カウント）
function achCheckSkillChain(finalCount) {
  const cat = ACH_CATS.find(c => c.id === 'skill_chain');
  if (!cat) return;
  for (const it of cat.items) {
    if (finalCount >= it.mergeThreshold) _unlockAch(it.id);
    else break;
  }
}

// 同時存在数チェック（bodyIndex = 天体インデックス, count = 現在フィールド上の個数）
function achCheckSimultaneous(bodyIndex, count) {
  const cat = ACH_CATS.find(c => c.simIndex === bodyIndex);
  if (!cat) return;
  for (const it of cat.items) {
    if (count >= it.simThreshold) _unlockAch(it.id);
    else break;
  }
}

// スキル経由の連鎖レベル別累計チェック（level=5〜10, total=累計達成回数）
function achCheckSkillChainByLevel(level, total) {
  const cat = ACH_CATS.find(c => c.id === `skill_chain${level}`);
  if (!cat) return;
  for (const it of cat.items) {
    if (total >= it.mergeThreshold) _unlockAch(it.id);
    else break;
  }
}

// ── 実績カード要素を生成（内部ヘルパー） ──
function _makeAchCard(it, lang, capL) {
  const isOn     = _unlocked.has(it.id);
  const isSecret = it.rarity === 'secret';
  const r        = ACH_RARITY[it.rarity];
  const rawName  = it[`name${capL}`] || it.nameJa;
  const rawCond  = it[`cond${capL}`] || it.condJa;
  const rawSub   = it[`sub${capL}`]  || it.subJa  || null;
  const rLbl     = r[lang] || r.ja;

  const name = (isOn || !isSecret) ? rawName : '???';
  const cond = (isOn || !isSecret) ? rawCond : '???';
  const sub  = (isOn || !isSecret) ? rawSub  : null;

  const card = document.createElement('div');
  card.className = 'ach-card' + (isOn ? ' ach-card-on' : ' ach-card-off');

  if (isSecret) {
    card.classList.add('ach-rainbow-border');
  } else {
    card.style.borderColor = r.border;
    card.style.background  = r.bg;
  }

  const rarityHtml = isSecret
    ? `<div class="ach-card-rarity ach-rainbow-text">${rLbl}</div>`
    : `<div class="ach-card-rarity" style="color:${r.text}">${rLbl}</div>`;

  card.innerHTML =
    `<div class="ach-card-icon">${isOn ? it.icon : '🔒'}</div>` +
    `<div class="ach-card-info">` +
      `<div class="ach-card-name">${name}</div>` +
      `<div class="ach-card-cond">${cond}</div>` +
      rarityHtml +
      (sub ? `<div class="ach-card-sub">${sub}</div>` : '') +
    `</div>`;

  return card;
}

// ── 実績オーバーレイの中身を描画 ──
function _renderAchBody() {
  const bodyEl  = document.getElementById('ach-body');
  const statsEl = document.getElementById('ach-stats');
  if (!bodyEl) return;

  const lang = typeof currentLang !== 'undefined' ? currentLang : 'ja';
  const capL = lang.charAt(0).toUpperCase() + lang.slice(1);
  const total    = _achById.size;
  const unlocked = _unlocked.size;

  if (statsEl) statsEl.textContent = `${unlocked} / ${total}`;

  bodyEl.innerHTML = '';

  // ACH_GROUPS の順に1グループ＝1アコーディオンで描画
  for (const grp of ACH_GROUPS) {
    // グループに属する全カテゴリのアイテムを順番に収集
    const allItems = ACH_CATS
      .filter(c => c.group === grp.id)
      .flatMap(c => c.items);
    if (!allItems.length) continue;

    const grpUnlocked = allItems.filter(i => _unlocked.has(i.id)).length;
    const grpName     = grp[`name${capL}`] || grp.nameJa;

    const section = document.createElement('div');
    section.className = 'ach-section';

    // アコーディオンヘッダー
    const pct = (grpUnlocked / allItems.length) * 100;
    const hdr = document.createElement('button');
    hdr.className = 'ach-section-hdr';
    hdr.innerHTML =
      `<div class="ach-cat-hdr-row">` +
        `<span class="ach-cat-icon">${grp.icon}</span>` +
        `<span class="ach-cat-name">${grpName}</span>` +
        `<span class="ach-cat-prog">${grpUnlocked}/${allItems.length}</span>` +
        `<span class="ach-cat-arrow">▶</span>` +
      `</div>` +
      `<div class="ach-cat-bar-wrap"><div class="ach-cat-bar" style="width:${pct.toFixed(1)}%"></div></div>`;

    // アイテムリスト（デフォルト折り畳み）
    const content = document.createElement('div');
    content.className = 'ach-section-body';

    for (const it of allItems) {
      content.appendChild(_makeAchCard(it, lang, capL));
    }

    // 開閉トグル
    let open = false;
    const toggleSection = () => {
      open = !open;
      toggleShow(content, open);
      hdr.querySelector('.ach-cat-arrow').textContent = open ? '▼' : '▶';
    };
    on(hdr, toggleSection);

    section.appendChild(hdr);
    section.appendChild(content);
    bodyEl.appendChild(section);
  }
}

// ── オーバーレイ開閉 ──
function openAchievements() {
  _renderAchBody();
  const overlay = document.getElementById('achievement-overlay');
  overlay.classList.add('show');
  // ホーム画面（#start-screen z-index:1000）から開いた場合は上に表示
  if (waiting) overlay.classList.add('above-start');
}

function closeAchievements() {
  const overlay = document.getElementById('achievement-overlay');
  overlay.classList.remove('show', 'above-start');
}

// ページ読み込み時にサーバーから解除済み実績を取得してマージ（バックグラウンド）
_syncFromServer();

// ── ボタンのバインド ──
(function () {
  const backBtn    = document.getElementById('ach-back-btn');
  const startBtn   = document.getElementById('start-ach-btn');
  const menuBtn    = document.getElementById('menu-ach-btn');
  // overlay-ach-btn は終了画面から削除済
  // ※ ホーム下部バーの「実績」(#nav-ach) は game.js の showHomeTab() が統括するため
  //   ここでは個別バインドしない（二重起動防止）。

  // click+touchend の二重登録は共通ユーティリティ on()（game-util.js）に統一。
  // on() は要素が null だと落ちるため、存在する場合のみバインドする。
  if (backBtn)    on(backBtn,    () => { playBackSound();     closeAchievements(); });
  if (startBtn)   on(startBtn,   () => { playDecisionSound(); openAchievements(); });
  if (menuBtn)    on(menuBtn,    () => { playDecisionSound(); openAchievements(); });

  // トーストをタップ/クリックで即スキップ（次の実績へ）
  const toastEl = document.getElementById('ach-toast');
  if (toastEl) on(toastEl, () => { if (_toastBusy) _dismissToast(); });
})();

// 言語切替時にオーバーレイが開いていたら再描画
document.addEventListener('langchange', () => {
  const overlay = document.getElementById('achievement-overlay');
  if (overlay && overlay.classList.contains('show')) _renderAchBody();
  const titleEl = document.getElementById('ach-title');
  if (titleEl && typeof T !== 'undefined') titleEl.textContent = T('achievements');
});
