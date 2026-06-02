'use strict';

// ============================================================
// game-motivation.js — やる気メッセージシステム
// ============================================================
// ホーム画面と終了画面でプレイヤーのモチベーションを引き出す短い文を出す。
// 候補を 4 カテゴリ集めて重み付きランダムで 1 件選ぶ。
// 時間経過 (8 秒) で別の候補に切り替える。
//
// カテゴリ:
//   A. モード解放条件 (未解放のとき重み大)
//   B. 各モードでの自己ベスト記録
//   C. ランキング (mode × period = 最大 6 種類)
//   D. 実績進捗 (近い未達成のもの数件)
//
// 公開 API:
//   pickMotivationMessage(callback)
//     即時にローカル候補から 1 件返し、その後ランキング API が解決したら
//     より豊富な候補で再度 callback を呼ぶ。
//   startMotivationCycle(element)
//     element に最新メッセージを表示し、8 秒ごとに次の候補へフェード切替。
//   stopMotivationCycle()
//     現在のサイクルを停止。
// ============================================================

const MOTIV_RANK_TTL_MS  = 10 * 60 * 1000;  // ランキング API キャッシュ
const MOTIV_CYCLE_MS     = 30000;           // 切替間隔 (じっくり読ませる)
const MOTIV_FADE_MS      = 400;             // フェード時間
let _motivRankCache = null;                  // {ts, data: [{mode, period, entries}]}
let _motivTimer     = null;
let _motivTargetEl  = null;
let _motivLastMessage = null;                // 直前と同じテキストを避けるため

function _motivFmtNum(n) { return Math.floor(n).toLocaleString(); }
function _motivFmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--.---';
  const total = Math.floor(ms);
  const min = Math.floor(total / 60000);
  const sec = Math.floor((total % 60000) / 1000);
  const mil = total % 1000;
  return `${min}:${String(sec).padStart(2,'0')}.${String(mil).padStart(3,'0')}`;
}

// T() ヘルパー（lang.js 未ロードでも安全に）
function _mT(key) { return (typeof T === 'function') ? T(key) : key; }
function _motivModeLabel(m) {
  const def = (typeof CFG !== 'undefined') ? CFG.MODES.find(x => x.id === m) : null;
  if (def && typeof modeName === 'function') return modeName(def);
  return m;
}
function _motivPeriodLabel(p) {
  return p === 'weekly' ? _mT('motivPeriodWeekly') : _mT('motivPeriodAll');
}
function _motivUnlockedModes() {
  const arr = ['endless'];
  if (typeof isModeUnlocked === 'function') {
    if (isModeUnlocked('speedrun')) arr.push('speedrun');
    if (isModeUnlocked('time'))     arr.push('time');
  }
  return arr;
}

// ── ランキング取得 (キャッシュ 10 分) ──
async function _motivFetchRankings() {
  const now = Date.now();
  if (_motivRankCache && (now - _motivRankCache.ts) < MOTIV_RANK_TTL_MS) {
    return _motivRankCache.data;
  }
  const modes   = _motivUnlockedModes();
  const periods = ['weekly', 'all'];
  const calls = [];
  for (const m of modes) {
    for (const p of periods) {
      calls.push(
        fetch(`/api/rollaxy/ranking?period=${p}&mode=${m}&limit=100`)
          .then(r => r.ok ? r.json() : { entries: [] })
          .then(d => ({ mode: m, period: p, entries: d.entries || [] }))
          .catch(() => ({ mode: m, period: p, entries: [] }))
      );
    }
  }
  const data = await Promise.all(calls);
  _motivRankCache = { ts: now, data };
  return data;
}

// ── 候補生成 ──
function _motivBuildCandidates() {
  const out = [];

  // A. モード解放
  const speedrunUnlocked = typeof isModeUnlocked === 'function' && isModeUnlocked('speedrun');
  const timeUnlocked     = typeof isModeUnlocked === 'function' && isModeUnlocked('time');
  if (!speedrunUnlocked) {
    out.push({ weight: 40, text: _mT('motivUnlockSpeedrun') });
  } else if (!timeUnlocked) {
    out.push({ weight: 35, text: _mT('motivUnlockTime') });
  }

  // B. 自己ベスト
  const bEnd  = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SCORE)       || '0', 10);
  const bTime = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SCORE_TIME)  || '0', 10);
  const bSpd  = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SPEEDRUN_MS) || '0', 10);
  if (bEnd > 0) {
    out.push({ weight: 12, text: _mT('motivBestEndless')(_motivFmtNum(bEnd)) });
  } else {
    out.push({ weight: 16, text: _mT('motivBestEndlessNone') });
  }
  if (speedrunUnlocked) {
    if (bSpd > 0) out.push({ weight: 12, text: _mT('motivBestSpeedrun')(_motivFmtTime(bSpd)) });
    else          out.push({ weight: 16, text: _mT('motivBestSpeedrunNone') });
  }
  if (timeUnlocked) {
    if (bTime > 0) out.push({ weight: 12, text: _mT('motivBestTime')(_motivFmtNum(bTime)) });
    else           out.push({ weight: 16, text: _mT('motivBestTimeNone') });
  }

  // C. ランキング (キャッシュがあるときだけ)
  if (_motivRankCache && _motivRankCache.data) {
    const myPid = (typeof getPlayerId === 'function') ? getPlayerId() : null;
    for (const r of _motivRankCache.data) {
      const mLab = _motivModeLabel(r.mode);
      const pLab = _motivPeriodLabel(r.period);
      const myIdx = myPid ? r.entries.findIndex(e => e.player_id === myPid) : -1;
      if (myIdx === 0) {
        out.push({ weight: 14, text: _mT('motivRankTop')(mLab, pLab) });
      } else if (myIdx > 0) {
        const me = r.entries[myIdx];
        const up = r.entries[myIdx - 1];
        if (r.mode === 'speedrun') {
          // score = 10_000_000 - ms。score 差 = ms 差 (大きい方が上)
          const diffMs = up.score - me.score;
          out.push({ weight: 13, text: _mT('motivRankCloseTime')(mLab, pLab, _motivFmtTime(diffMs), myIdx) });
        } else {
          const diff = up.score - me.score;
          out.push({ weight: 13, text: _mT('motivRankCloseScore')(mLab, pLab, _motivFmtNum(diff), myIdx) });
        }
      } else if (r.entries.length > 0) {
        // 圏外。トップとの差を提示
        const top = r.entries[0];
        if (r.mode === 'speedrun') {
          out.push({ weight: 6, text: _mT('motivRankTopTime')(mLab, pLab, _motivFmtTime(10_000_000 - top.score)) });
        } else {
          out.push({ weight: 6, text: _mT('motivRankTopScore')(mLab, pLab, _motivFmtNum(top.score)) });
        }
      } else {
        out.push({ weight: 5, text: _mT('motivRankEmpty')(mLab, pLab) });
      }
    }
  }

  // D. 実績進捗 (近いものから最大 4 件)
  if (typeof ACH_CATS !== 'undefined' && typeof _unlocked !== 'undefined') {
    out.push(..._motivPickAchievements());
  }

  return out;
}

function _motivPickAchievements() {
  const items = [];
  for (const cat of ACH_CATS) {
    for (const it of cat.items) {
      if (_unlocked.has(it.id)) continue;
      const progress = _motivGetAchProgress(cat, it);
      if (!progress) continue;
      const { cur, max, unitJa = '', unitEn = '', unitZh = '' } = progress;
      if (max <= 0) continue;
      const ratio  = Math.min(1, cur / max);
      if (ratio < 0.4) continue; // 進捗 40% 未満は遠いので除外
      const remain = max - cur;
      if (remain <= 0) continue;
      const capL = (typeof currentLang === 'string')
        ? currentLang.charAt(0).toUpperCase() + currentLang.slice(1) : 'Ja';
      const cond = it['cond' + capL] || it.condJa;
      const unitMap = { Ja: unitJa, En: unitEn, Zh: unitZh };
      const unit = unitMap[capL] ?? unitJa;
      items.push({
        weight: Math.max(5, Math.round(ratio * 18)), // 近いほど重み大
        ratio,
        text: _mT('motivAch')(_motivFmtNum(remain) + unit, cond),
      });
    }
  }
  items.sort((a, b) => b.ratio - a.ratio);
  return items.slice(0, 4);
}

function _motivGetAchProgress(cat, it) {
  // スコア系
  if (cat.id === 'score' && it.scoreThreshold) {
    const cur = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SCORE) || '0', 10);
    return { cur, max: it.scoreThreshold, unitJa: '点', unitEn: ' pts', unitZh: '分' };
  }
  // 合成系 (累計)
  if (cat.id === 'merge' && it.mergeThreshold) {
    const cur = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_MERGES) || '0', 10);
    return { cur, max: it.mergeThreshold, unitJa: '回', unitEn: ' merges', unitZh: '次' };
  }
  // 連鎖系 (累計)
  if (cat.id === 'chain_total' && it.mergeThreshold) {
    const cur = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_CHAINS) || '0', 10);
    return { cur, max: it.mergeThreshold, unitJa: '回', unitEn: ' chains', unitZh: '次' };
  }
  // 天体種別合成
  if (typeof cat.bodyIndex === 'number' && it.mergeThreshold) {
    try {
      const bm = JSON.parse(localStorage.getItem(STORAGE_KEYS.BODY_MERGES) || '{}');
      const cur = (bm[String(cat.bodyIndex)] || 0);
      return { cur, max: it.mergeThreshold, unitJa: '回', unitEn: ' merges', unitZh: '次' };
    } catch (_) { return null; }
  }
  return null;
}

function _motivWeightedPick(list, excludeText) {
  if (list.length === 0) return null;
  let filtered = excludeText ? list.filter(c => c.text !== excludeText) : list;
  if (filtered.length === 0) filtered = list;
  const total = filtered.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const c of filtered) {
    r -= c.weight;
    if (r <= 0) return c.text;
  }
  return filtered[filtered.length - 1].text;
}

// ── 公開 API ──
function pickMotivationMessage(callback) {
  const local = _motivWeightedPick(_motivBuildCandidates(), _motivLastMessage);
  if (local) { _motivLastMessage = local; callback(local); }
  // ランキング非同期。完了後、より豊富な候補で 1 度だけ再選択
  _motivFetchRankings().then(() => {
    const full = _motivWeightedPick(_motivBuildCandidates(), _motivLastMessage);
    if (full) { _motivLastMessage = full; callback(full); }
  }).catch(() => {});
}

let _motivCurrentText = '';

// メッセージ + 残り時間バーを要素内に描画。バーは MOTIV_CYCLE_MS で空になる。
function _motivRenderInto(el, msg) {
  let textEl = el.querySelector('.motiv-text');
  let barEl  = el.querySelector('.motiv-bar-fill');
  if (!textEl) {
    el.innerHTML = '<div class="motiv-text"></div>'
                 + '<div class="motiv-bar"><div class="motiv-bar-fill"></div></div>';
    textEl = el.querySelector('.motiv-text');
    barEl  = el.querySelector('.motiv-bar-fill');
  }
  textEl.textContent = msg;
  _motivCurrentText = msg;
  if (barEl) {
    barEl.style.animation = 'none';
    void barEl.offsetWidth; // reflow でアニメーションをリセット
    barEl.style.animation = `motivBarDeplete ${MOTIV_CYCLE_MS}ms linear forwards`;
  }
}

function startMotivationCycle(el) {
  if (!el) return;
  stopMotivationCycle();
  _motivTargetEl = el;
  _motivShowNext(true); // 初回は即時
}

function _motivShowNext(immediate) {
  const el = _motivTargetEl;
  if (!el) return;
  const apply = () => {
    pickMotivationMessage((msg) => {
      if (_motivTargetEl !== el) return;
      _motivRenderInto(el, msg);
      el.classList.remove('motiv-fading');
    });
    _motivScheduleNext();
  };
  if (immediate) {
    apply();
  } else {
    el.classList.add('motiv-fading');
    setTimeout(apply, MOTIV_FADE_MS);
  }
}

function _motivScheduleNext() {
  if (_motivTimer) clearTimeout(_motivTimer);
  _motivTimer = setTimeout(() => _motivShowNext(false), MOTIV_CYCLE_MS);
}

function stopMotivationCycle() {
  if (_motivTimer) { clearTimeout(_motivTimer); _motivTimer = null; }
  if (_motivTargetEl) {
    const bar = _motivTargetEl.querySelector('.motiv-bar-fill');
    if (bar) bar.style.animation = 'none';
  }
  _motivTargetEl = null;
  _closeMotivDetail();
}

// ── タップ詳細表示（読みやすく拡大、表示中はサイクル一時停止）──
function _motivPause() {
  if (_motivTimer) { clearTimeout(_motivTimer); _motivTimer = null; }
  if (_motivTargetEl) {
    const bar = _motivTargetEl.querySelector('.motiv-bar-fill');
    if (bar) bar.style.animationPlayState = 'paused';
  }
}
function _motivResume() {
  if (!_motivTargetEl) return;
  // 現在のメッセージのまま、バーとタイマーを最初から（読み終えたら再び30秒）
  _motivRenderInto(_motivTargetEl, _motivCurrentText);
  _motivScheduleNext();
}
function _openMotivDetail() {
  const modal = document.getElementById('motiv-detail-modal');
  if (!modal || !_motivCurrentText || !_motivTargetEl) return;
  const txt = document.getElementById('motiv-detail-text');
  if (txt) txt.textContent = _motivCurrentText;
  const closeBtn = document.getElementById('motiv-detail-close');
  if (closeBtn) closeBtn.textContent = _mT('modeUnlockClose');
  modal.classList.add('show');
  _motivPause();
}
function _closeMotivDetail() {
  const modal = document.getElementById('motiv-detail-modal');
  if (!modal || !modal.classList.contains('show')) return;
  modal.classList.remove('show');
  _motivResume();
}

// やる気ボックスのタップで詳細を開く（両ボックス共通）。on() は game-util.js。
(function _bindMotivTaps() {
  const ids = ['home-motivation', 'overlay-motivation'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && typeof on === 'function') on(el, () => _openMotivDetail());
  }
  const modal   = document.getElementById('motiv-detail-modal');
  const closeBtn = document.getElementById('motiv-detail-close');
  if (closeBtn && typeof on === 'function') on(closeBtn, () => _closeMotivDetail());
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) _closeMotivDetail(); });
})();
