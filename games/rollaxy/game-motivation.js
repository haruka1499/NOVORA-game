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
let _motivCurrentGoal = null;               // 現在表示中のメッセージに紐づくゴール
// game.js からセット: 目標ボタンが押されたときに呼ぶコールバック
var _motivOnGoalSelect = null;

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
    const txt = _mT('motivUnlockSpeedrun');
    out.push({ weight: 40, text: txt, goal: { type:'unlock', modeId:'speedrun', requiredTier:8, displayText:txt } });
  } else if (!timeUnlocked) {
    const txt = _mT('motivUnlockTime');
    out.push({ weight: 35, text: txt, goal: { type:'unlock', modeId:'time', requiredTier:11, displayText:txt } });
  }

  // B. 自己ベスト（エンドレスのみゴール対応）
  const bEnd  = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SCORE)       || '0', 10);
  const bTime = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SCORE_TIME)  || '0', 10);
  const bSpd  = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SPEEDRUN_MS) || '0', 10);
  if (bEnd > 0) {
    const txt = _mT('motivBestEndless')(_motivFmtNum(bEnd));
    out.push({ weight: 12, text: txt, goal: { type:'best', mode:'endless', currentBest:bEnd, displayText:txt } });
  } else {
    const txt = _mT('motivBestEndlessNone');
    out.push({ weight: 16, text: txt, goal: { type:'best', mode:'endless', currentBest:0, displayText:txt } });
  }
  if (speedrunUnlocked) {
    if (bSpd > 0) out.push({ weight: 12, text: _mT('motivBestSpeedrun')(_motivFmtTime(bSpd)) });
    else          out.push({ weight: 16, text: _mT('motivBestSpeedrunNone') });
  }
  if (timeUnlocked) {
    if (bTime > 0) out.push({ weight: 12, text: _mT('motivBestTime')(_motivFmtNum(bTime)) });
    else           out.push({ weight: 16, text: _mT('motivBestTimeNone') });
  }

  // C. ランキング（エンドレスのみゴール対応）
  if (_motivRankCache && _motivRankCache.data) {
    const myPid = (typeof getPlayerId === 'function') ? getPlayerId() : null;
    for (const r of _motivRankCache.data) {
      const mLab = _motivModeLabel(r.mode);
      const pLab = _motivPeriodLabel(r.period);
      const myIdx = myPid ? r.entries.findIndex(e => e.player_id === myPid) : -1;
      const isEndless = (r.mode === 'endless');
      if (myIdx === 0) {
        // 1位: 2位との差を表示（防衛メッセージ）
        if (r.entries.length > 1) {
          const me = r.entries[0];
          const challenger = r.entries[1];
          if (r.mode === 'speedrun') {
            // speedrun: score = 10_000_000 - ms。差が小さいほど2位に近い
            const diffMs = me.score - challenger.score;
            out.push({ weight: 14, text: _mT('motivRankDefendTime')(mLab, pLab, _motivFmtTime(diffMs)) });
          } else {
            const diff = me.score - challenger.score;
            const txt = _mT('motivRankDefend')(mLab, pLab, _motivFmtNum(diff));
            out.push({ weight: 14, text: txt,
              goal: isEndless ? { type:'best', mode:'endless', currentBest: me.score, displayText: txt } : null });
          }
        } else {
          // 自分だけ → 従来の「防衛しよう」
          out.push({ weight: 14, text: _mT('motivRankTop')(mLab, pLab) });
        }
      } else if (myIdx > 0) {
        // 2位以下: 1つ上の人との差を表示
        const me = r.entries[myIdx];
        const up = r.entries[myIdx - 1];
        if (r.mode === 'speedrun') {
          const diffMs = up.score - me.score;
          out.push({ weight: 13, text: _mT('motivRankCloseTime')(mLab, pLab, _motivFmtTime(diffMs), myIdx + 1) });
        } else {
          const diff = up.score - me.score;
          const txt = _mT('motivRankCloseScore')(mLab, pLab, _motivFmtNum(diff), myIdx + 1);
          out.push({ weight: 13, text: txt,
            goal: isEndless ? { type:'rank', mode:'endless', targetScore:up.score, displayText:txt } : null });
        }
      } else if (r.entries.length > 0) {
        // 圏外: 1位ではなく最下位のスコアを目標に（ランクインを促す）
        if (r.mode === 'speedrun') {
          // speedrun は1位タイムを維持（タイムアタック的な性質）
          const top = r.entries[0];
          out.push({ weight: 4, text: _mT('motivRankTopTime')(mLab, pLab, _motivFmtTime(10_000_000 - top.score)) });
        } else {
          const last = r.entries[r.entries.length - 1];
          const txt = _mT('motivRankJoin')(mLab, pLab, _motivFmtNum(last.score), last.rank || r.entries.length);
          out.push({ weight: 5, text: txt,
            goal: isEndless ? { type:'rank', mode:'endless', targetScore:last.score, displayText:txt } : null });
        }
      } else {
        const txt = _mT('motivRankEmpty')(mLab, pLab);
        out.push({ weight: 5, text: txt,
          goal: isEndless ? { type:'rank', mode:'endless', targetScore:0, displayText:txt } : null });
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
      const motivText = _mT('motivAch')(_motivFmtNum(remain) + unit, cond);
      items.push({
        weight: Math.max(5, Math.round(ratio * 18)), // 近いほど重み大
        ratio,
        text: motivText,
        goal: {
          type: 'ach', achId: it.id, catId: cat.id,
          bodyIndex:  typeof cat.bodyIndex  === 'number' ? cat.bodyIndex  : null,
          chainLevel: typeof cat.chainLevel === 'number' ? cat.chainLevel : null,
          targetCount: max, savedCount: cur,
          unitJa, unitEn, unitZh,
          displayText: motivText,
        },
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
  // 累計連鎖系 (chain_total)
  if (cat.id === 'chain_total' && it.mergeThreshold) {
    const cur = parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_CHAINS) || '0', 10);
    return { cur, max: it.mergeThreshold, unitJa: '回', unitEn: ' chains', unitZh: '次' };
  }
  // 連鎖レベル別 (chain5/chain6/.../chain9)
  if (typeof cat.chainLevel === 'number' && it.mergeThreshold) {
    try {
      const cc = JSON.parse(localStorage.getItem(STORAGE_KEYS.CHAIN_COUNTS) || '[]');
      const cur = cc[cat.chainLevel] || 0;
      return { cur, max: it.mergeThreshold, unitJa: '回', unitEn: ' times', unitZh: '次' };
    } catch (_) { return null; }
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

// フルオブジェクト {text, goal} を返す
function _motivWeightedPick(list, excludeText) {
  if (list.length === 0) return null;
  let filtered = excludeText ? list.filter(c => c.text !== excludeText) : list;
  if (filtered.length === 0) filtered = list;
  const total = filtered.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const c of filtered) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return filtered[filtered.length - 1];
}

// ── 公開 API ──
// callback(text, goal|null) で呼び出す
function pickMotivationMessage(callback) {
  const local = _motivWeightedPick(_motivBuildCandidates(), _motivLastMessage);
  if (local) { _motivLastMessage = local.text; callback(local.text, local.goal || null); }
  // ランキング非同期。完了後、より豊富な候補で 1 度だけ再選択
  _motivFetchRankings().then(() => {
    const full = _motivWeightedPick(_motivBuildCandidates(), _motivLastMessage);
    if (full) { _motivLastMessage = full.text; callback(full.text, full.goal || null); }
  }).catch(() => {});
}

let _motivCurrentText = '';

// メッセージ + 残り時間バー + 目標ボタンを要素内に描画。
function _motivRenderInto(el, msg, goal) {
  _motivCurrentGoal = goal || null;
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
    void barEl.offsetWidth;
    barEl.style.animation = `motivBarDeplete ${MOTIV_CYCLE_MS}ms linear forwards`;
  }
  // 目標ボタン（goal がある場合のみ表示）
  let btnEl = el.querySelector('.motiv-goal-btn');
  if (goal) {
    if (!btnEl) {
      btnEl = document.createElement('button');
      btnEl.className = 'motiv-goal-btn';
      btnEl.dataset.i18n = 'motivGoalBtn'; // applyLang() で言語切替時に自動更新
      el.appendChild(btnEl);
      btnEl.addEventListener('click', (e) => {
        e.stopPropagation(); // 詳細モーダルを開かないようにする
        if (typeof _motivOnGoalSelect === 'function' && _motivCurrentGoal) {
          _motivOnGoalSelect(_motivCurrentGoal);
        }
      });
    }
    btnEl.textContent = _mT('motivGoalBtn');
  } else if (btnEl) {
    btnEl.remove();
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
    pickMotivationMessage((msg, goal) => {
      if (_motivTargetEl !== el) return;
      _motivRenderInto(el, msg, goal);
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
