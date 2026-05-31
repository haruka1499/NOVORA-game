'use strict';

// ============================================================
// game-research.js — 新研究ツリー (R1)
// ============================================================
// データ・コストは research-balance.js に集約。
// このファイルはロジック (取得可否判定、購入処理、効果集計、UI 描画) のみ担当。
//
// 旧 CFG.META.RESEARCH / CFG.META.PERMANENT_RESEARCH は廃止 (config.js から削除済)。
// metaState.research / .permanentResearch / .civLevel も廃止。
//   → 互換: 旧データを 1 度だけ migrate して捨てる。新規ユーザーは migrate スキップ。
// 新しい持ち物:
//   metaState.unlockedResearch : Set<nodeId>  取得済みノード
//   metaState.researchPoints   : number       RP 残高
// ============================================================

// ── ノード索引 ──
const RESEARCH_NODE_BY_ID = (() => {
  const m = {};
  for (const n of RESEARCH_TREE) m[n.id] = n;
  return m;
})();
function researchNode(id) { return RESEARCH_NODE_BY_ID[id] || null; }

// 取得済みか
function isResearchUnlocked(id) {
  return metaState.unlockedResearch && metaState.unlockedResearch.has(id);
}
// 全前提を満たしているか
function isResearchAvailable(id) {
  const n = researchNode(id);
  if (!n || isResearchUnlocked(n.id)) return false;
  for (const p of n.prereqs) if (!isResearchUnlocked(p)) return false;
  return true;
}
function canBuyResearchNode(id) {
  const n = researchNode(id);
  if (!n || !isResearchAvailable(id)) return false;
  return metaState.researchPoints >= n.cost;
}
// 取得
function buyResearchNode(id) {
  const n = researchNode(id);
  if (!canBuyResearchNode(id)) return false;
  metaState.researchPoints -= n.cost;
  metaState.unlockedResearch.add(id);
  saveMeta();
  updateResourceBar();
  if (typeof logEvent === 'function') {
    logEvent('research_unlock_v2', { game_id: 'rollaxy', node_id: id, cost: n.cost });
  }
  return true;
}

// ── 効果集計 (旧 getModifier を新ツリーで置換) ──
// 倍率系: 1 + Σ value、加算系: Σ value
const _MULT_KEYS = new Set([
  'rewardMult', 'scoreMult', 'starRateMult', 'genCostMult',
  'civPointMult', 'massGrowthMult', 'planetCostMult',
  'offlineRateMult', 'highTierBonus', 'highTierSpawnMult',
  'spawnRateMult', 'fallSpeedMult', 'gravityWell', 'chainMultBonus',
  'planetBonus', 'mergeAssist',
]);
function getModifier(key) {
  let sum = 0;
  if (!metaState.unlockedResearch) return _MULT_KEYS.has(key) ? 1 : 0;
  for (const id of metaState.unlockedResearch) {
    const n = researchNode(id);
    if (!n || !n.effect) continue;
    if (n.effect.type === key) sum += n.effect.value;
  }
  return _MULT_KEYS.has(key) ? (1 + sum) : sum;
}

// ── RP 獲得 ──
function awardRpFromScore(score) {
  if (!Number.isFinite(score) || score <= 0) return 0;
  const rp = Math.floor(score * RESEARCH_BALANCE.RP_PER_SCORE);
  if (rp <= 0) return 0;
  metaState.researchPoints += rp;
  return rp;
}
function awardRpFromChain(chainCount) {
  if (chainCount < 5) return 0;
  const rp = RESEARCH_BALANCE.RP_PER_CHAIN_5UP;
  metaState.researchPoints += rp;
  return rp;
}
function awardRpFromSupernova() {
  const rp = RESEARCH_BALANCE.RP_PER_SUPERNOVA;
  metaState.researchPoints += rp;
  return rp;
}
// 放置経過分の RP を加算。settleEnergy と同タイミングで呼ぶ
function awardRpFromIdle(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  const cap = Math.min(sec, RESEARCH_BALANCE.RP_IDLE_CAP_SEC);
  const rp = Math.floor(cap * RESEARCH_BALANCE.RP_PER_IDLE_SEC);
  if (rp <= 0) return 0;
  metaState.researchPoints += rp;
  return rp;
}

// ── 旧データの 1 度きり移行 ──
function _migrateLegacyResearch() {
  // 1) 旧通常研究 + 永続研究があれば、それぞれ対応する新ノードを取得済み扱いにする
  // 2) localStorage から消す (再 migrate を防ぐ)
  const oldNormal = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.META_RESEARCH) || '[]')); }
    catch (_) { return new Set(); }
  })();
  const oldPerm = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.META_PERM_RESEARCH) || '[]')); }
    catch (_) { return new Set(); }
  })();
  if (oldNormal.size === 0 && oldPerm.size === 0) return; // 旧データなし

  // 旧 ID → 新 ID マップ (近い効果のノードに割当)
  const map = {
    'r_reward1':  'mining',           // 星屑 +15% → 星屑採掘
    'r_reward2':  'mining_eff',       // 星屑 +25% → 採掘効率化
    'r_score1':   null,               // 旧スコア研究はマップ無し (RP 還元なし、捨て)
    'r_score2':   null,
    'r_star1':    'gen_tech',         // 恒星 +20% → 生成技術
    'r_gencost1': null,               // 生成コスト -10% は新ツリー方針外
    'r_skill1':   null,
    'r_time1':    null,
    'perm_civ1':  'colonize',
    'perm_civ2':  'supernova_eng',
    'perm_mass1': 'star_research',
    'perm_planet1': 'planet_dev',
  };
  for (const oldId of [...oldNormal, ...oldPerm]) {
    const newId = map[oldId];
    if (!newId) continue;
    // 新 ID が存在し、かつ前提が満たされていなくても取得済みにする (移行特例)
    if (researchNode(newId)) metaState.unlockedResearch.add(newId);
  }
  // 旧データ削除
  localStorage.removeItem(STORAGE_KEYS.META_RESEARCH);
  localStorage.removeItem(STORAGE_KEYS.META_PERM_RESEARCH);
  // 旧文明レベルも撤去 (将来の混乱を避ける)
  localStorage.removeItem(STORAGE_KEYS.META_CIV_LEVEL);
}

// ── 永続化 (loadResearch/saveResearch は metaState 経由) ──
function loadResearch() {
  let ids = [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.META_RESEARCH_TREE) || '[]');
    if (Array.isArray(raw)) ids = raw;
  } catch (_) { ids = []; }
  const valid = new Set(RESEARCH_TREE.map(n => n.id));
  metaState.unlockedResearch = new Set(ids.filter(id => valid.has(id)));
  metaState.researchPoints   = Math.max(0, Math.floor(parseFloat(localStorage.getItem(STORAGE_KEYS.META_RP)) || 0));
  _migrateLegacyResearch();
}
function saveResearch() {
  localStorage.setItem(STORAGE_KEYS.META_RESEARCH_TREE, JSON.stringify([...metaState.unlockedResearch]));
  localStorage.setItem(STORAGE_KEYS.META_RP, String(metaState.researchPoints));
}

// ── UI 描画 (R1: 軸ごとのリスト表示) ──
// R2 で SVG ツリーに置換予定。
function renderResearchTree() {
  if (!document.getElementById('research-list')) return;
  // 上部に RP 残高
  const cur = (typeof currentLang === 'string') ? currentLang : 'ja';
  const fmt = (n) => Math.floor(n).toLocaleString();
  const T_ = (k, ...args) => typeof T === 'function' ? (typeof T(k) === 'function' ? T(k)(...args) : T(k)) : k;
  _setTxt('research-rp-val', fmt(metaState.researchPoints));

  const list = document.getElementById('research-list');
  let html = '';
  for (const axis of RESEARCH_AXES) {
    const axName = axis['name' + (cur === 'en' ? 'En' : cur === 'zh' ? 'Zh' : 'Ja')] || axis.nameJa;
    html += `<div class="research-axis-header">${axName}</div>`;
    const nodes = RESEARCH_TREE.filter(n => n.axis === axis.id).sort((a, b) => a.tier - b.tier);
    for (const n of nodes) {
      const nm = n['name' + (cur === 'en' ? 'En' : cur === 'zh' ? 'Zh' : 'Ja')] || n.nameJa;
      const ds = n['desc' + (cur === 'en' ? 'En' : cur === 'zh' ? 'Zh' : 'Ja')] || n.descJa;
      let status, cls, disabled;
      if (isResearchUnlocked(n.id)) {
        status = '✓'; cls = 'owned'; disabled = true;
      } else if (!isResearchAvailable(n.id)) {
        // 前提未達: 必要ノードを表示
        const missing = n.prereqs.filter(p => !isResearchUnlocked(p));
        const missNames = missing.map(p => {
          const nd = researchNode(p);
          return nd ? (nd['name' + (cur === 'en' ? 'En' : cur === 'zh' ? 'Zh' : 'Ja')] || nd.nameJa) : p;
        }).join(', ');
        status = `🔒 ${missNames}`;
        cls = 'locked'; disabled = true;
      } else {
        status = `🧪 ${fmt(n.cost)}`;
        disabled = metaState.researchPoints < n.cost;
        cls = disabled ? 'poor' : 'buy';
      }
      html += `<div class="research-item ${cls}" data-tier="${n.tier}">`
            + `<div class="research-info">`
            +   `<div class="research-name">${nm}</div>`
            +   `<div class="research-desc">${ds}</div></div>`
            + `<button class="research-buy-btn" data-id="${n.id}"${disabled ? ' disabled' : ''}>${status}</button>`
            + `</div>`;
    }
  }
  list.innerHTML = html;
}

// ── デバッグ用 API (debug.js から呼ぶ) ──
function _debugUnlockAllResearch() {
  for (const n of RESEARCH_TREE) metaState.unlockedResearch.add(n.id);
  saveMeta(); updateResourceBar(); renderResearchTree();
}
function _debugResetResearch() {
  metaState.unlockedResearch.clear();
  saveMeta(); updateResourceBar(); renderResearchTree();
}
function _debugGiveRp(n) {
  metaState.researchPoints += Math.max(0, Math.floor(n));
  saveMeta(); updateResourceBar(); renderResearchTree();
}
