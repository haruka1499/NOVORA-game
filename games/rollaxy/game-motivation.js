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
const MOTIV_CYCLE_MS     = 8000;            // 切替間隔
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
      const { cur, max } = progress;
      if (max <= 0) continue;
      const ratio  = Math.min(1, cur / max);
      if (ratio < 0.4) continue; // 進捗 40% 未満は遠いので除外
      const remain = max - cur;
      if (remain <= 0) continue;
      const capL = (typeof currentLang === 'string')
        ? currentLang.charAt(0).toUpperCase() + currentLang.slice(1) : 'Ja';
      const name = it['name' + capL] || it.nameJa;
      items.push({
        weight: Math.max(5, Math.round(ratio * 18)), // 近いほど重み大
        ratio,
        text: _mT('motivAch')(_motivFmtNum(remain), name),
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
    return { cur, max: it.scoreThreshold };
  }
  // 合成系 (累計)
  if (cat.id === 'merge' && it.mergeThreshold) {
    const cur = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_MERGES) || '0', 10);
    return { cur, max: it.mergeThreshold };
  }
  // 連鎖系 (累計)
  if (cat.id === 'chain_total' && it.mergeThreshold) {
    const cur = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_CHAINS) || '0', 10);
    return { cur, max: it.mergeThreshold };
  }
  // 天体種別合成
  if (typeof cat.bodyIndex === 'number' && it.mergeThreshold) {
    try {
      const bm = JSON.parse(localStorage.getItem(STORAGE_KEYS.BODY_MERGES) || '{}');
      const cur = (bm[String(cat.bodyIndex)] || 0);
      return { cur, max: it.mergeThreshold };
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

function startMotivationCycle(el) {
  if (!el) return;
  stopMotivationCycle();
  _motivTargetEl = el;
  // 初回即時表示
  pickMotivationMessage((msg) => {
    if (_motivTargetEl !== el) return; // すでに別要素へ切替済み
    el.textContent = msg;
    el.classList.remove('motiv-fading');
  });
  _motivTimer = setInterval(() => {
    if (!_motivTargetEl) return;
    _motivTargetEl.classList.add('motiv-fading');
    setTimeout(() => {
      pickMotivationMessage((msg) => {
        if (!_motivTargetEl) return;
        _motivTargetEl.textContent = msg;
        _motivTargetEl.classList.remove('motiv-fading');
      });
    }, MOTIV_FADE_MS);
  }, MOTIV_CYCLE_MS);
}

function stopMotivationCycle() {
  if (_motivTimer) { clearInterval(_motivTimer); _motivTimer = null; }
  _motivTargetEl = null;
}
