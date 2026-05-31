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

// ── UI 描画 (R2: SVG エッジ + 絶対配置ノードのハイブリッド)──
// レイアウト:
//   X = tier (横方向に進行)、Y = 軸 ごとに帯
//   軸内で tier ごとに節点を縦に分散配置
//   エッジは SVG path (ベジエ曲線) で背景描画、ノードは HTML div 重ね
// 構造:
//   #research-list > #research-tree-wrap > #research-tree-canvas
//     > svg (絶対) + div.research-node × N (絶対)
// 横スクロールは #research-tree-wrap で overflow-x: auto
function renderResearchTree() {
  if (!document.getElementById('research-list')) return;
  const cur    = (typeof currentLang === 'string') ? currentLang : 'ja';
  const langK  = cur === 'en' ? 'En' : cur === 'zh' ? 'Zh' : 'Ja';
  const fmt    = (n) => Math.floor(n).toLocaleString();
  _setTxt('research-rp-val', fmt(metaState.researchPoints));

  // レイアウト定数
  const NODE_W   = 124;
  const NODE_H   = 60;
  const COL_GAP  = 50;   // tier 間 X 距離
  const ROW_GAP  = 16;   // 同 tier 内のノード間 Y 距離
  const AXIS_GAP = 38;   // 軸間の余白
  const PAD      = 28;

  // 軸 → tier → [node...] にグルーピング
  const groups = {};
  for (const node of RESEARCH_TREE) {
    (groups[node.axis] = groups[node.axis] || {});
    (groups[node.axis][node.tier] = groups[node.axis][node.tier] || []).push(node);
  }

  // 各ノードの座標を計算
  const positions = {};
  const axisBands = []; // { id, name, y, h }
  let curY = PAD;
  for (const axis of RESEARCH_AXES) {
    const axisData = groups[axis.id];
    if (!axisData) continue;
    const tiers = Object.keys(axisData).map(Number).sort((a, b) => a - b);
    if (!tiers.length) continue;
    const maxNodes  = Math.max(...tiers.map(t => axisData[t].length));
    const axisHeight = Math.max(NODE_H, maxNodes * NODE_H + (maxNodes - 1) * ROW_GAP);
    axisBands.push({
      id: axis.id,
      name: axis['name' + langK] || axis.nameJa,
      y: curY - 6,
      h: axisHeight + 12,
    });
    for (const t of tiers) {
      const nodes = axisData[t];
      const blockH = nodes.length * NODE_H + (nodes.length - 1) * ROW_GAP;
      const startY = curY + (axisHeight - blockH) / 2;
      for (let i = 0; i < nodes.length; i++) {
        positions[nodes[i].id] = {
          x: PAD + t * (NODE_W + COL_GAP),
          y: startY + i * (NODE_H + ROW_GAP),
        };
      }
    }
    curY += axisHeight + AXIS_GAP;
  }

  // 全体サイズ
  let maxX = 0, maxY = 0;
  for (const id in positions) {
    const p = positions[id];
    if (p.x + NODE_W > maxX) maxX = p.x + NODE_W;
    if (p.y + NODE_H > maxY) maxY = p.y + NODE_H;
  }
  const W = maxX + PAD;
  const H = maxY + PAD;

  // SVG エッジを構築 (前提ノード → 子ノード のベジエ曲線)
  let svgEdges = '';
  for (const node of RESEARCH_TREE) {
    const to = positions[node.id];
    if (!to) continue;
    for (const pid of node.prereqs) {
      const from = positions[pid];
      if (!from) continue;
      const fx = from.x + NODE_W;
      const fy = from.y + NODE_H / 2;
      const tx = to.x;
      const ty = to.y + NODE_H / 2;
      const dx = Math.max(20, (tx - fx) / 2);
      const cls = isResearchUnlocked(node.id) ? 'e-owned'
                : isResearchAvailable(node.id) ? 'e-available' : 'e-locked';
      svgEdges += `<path class="research-edge ${cls}" d="M ${fx} ${fy} C ${fx+dx} ${fy} ${tx-dx} ${ty} ${tx} ${ty}" fill="none"/>`;
    }
  }
  // 軸の帯 (薄い背景)
  let svgBands = '';
  for (const b of axisBands) {
    svgBands += `<rect class="research-axis-band" x="0" y="${b.y}" width="${W}" height="${b.h}" />`;
    svgBands += `<text class="research-axis-label" x="${PAD - 8}" y="${b.y + 18}">${b.name}</text>`;
  }

  // ノード DOM (絶対配置の div)
  let nodesHtml = '';
  for (const node of RESEARCH_TREE) {
    const p = positions[node.id];
    if (!p) continue;
    let cls = 'locked', stateLbl;
    if (isResearchUnlocked(node.id)) {
      cls = 'owned';
      stateLbl = '✓ 取得済み';
    } else if (isResearchAvailable(node.id)) {
      cls = canBuyResearchNode(node.id) ? 'buy' : 'poor';
      stateLbl = `🧪${fmt(node.cost)}`;
    } else {
      cls = 'locked';
      stateLbl = '🔒';
    }
    const name = node['name' + langK] || node.nameJa;
    const desc = node['desc' + langK] || node.descJa;
    nodesHtml += `<div class="research-node ${cls}" `
              + `data-id="${node.id}" `
              + `style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px" `
              + `title="${desc}">`
              +   `<div class="rn-name">${name}</div>`
              +   `<div class="rn-state">${stateLbl}</div>`
              + `</div>`;
  }

  // 全体組立
  const list = document.getElementById('research-list');
  list.innerHTML = `<div id="research-tree-wrap"><div id="research-tree-canvas" style="width:${W}px;height:${H}px">`
                + `<svg class="research-tree-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgBands}${svgEdges}</svg>`
                + nodesHtml
                + `</div></div>`;
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
