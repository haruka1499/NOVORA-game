'use strict';

// ============================================================
// game-meta.js — メタ進行（インクリメンタル）
//
// ループ:
//   プレイ → スコア/連鎖に応じて 星屑(stardust)・恒星エネルギー(energy) 獲得
//        → 星屑で「物質生成器」を強化（Lvアップ）
//        → 恒星サイズ↑ → 自動で得られる恒星エネルギー/秒↑（放置でも蓄積・上限あり）
//
// 文明レベル: 恒星エネルギーを消費してレベルアップ → 研究の解禁ゲート。
// 研究: 星屑で購入し、effect を getModifier() で中央集計して各所に適用。
//
// 数値は config.js の CFG.META に集約。UI はホーム下部バーから開く
// #cosmos-overlay（恒星/生成器）と #research-overlay（文明/研究）。
// ============================================================

// ---- 永続状態 ----
const metaState = {
  stardust: 0,
  energy:   0,
  mass:     0, // 物質生成器が蓄積した質量
  genLevel: CFG.META.GENERATOR.START_LEVEL,
  civLevel: CFG.META.CIV.START_LEVEL,
  unlockedResearch: new Set(), // 新研究ツリー: 取得済みノードID (R1)
  researchPoints:   0,         // 研究ポイント (RP) 残高 (R1)
  planets: [],         // 【アクティブ恒星の鏡】生成済み惑星 [{ key, name }]
  civPoints: 0,        // 文明ポイント（超新星で獲得・永続）
  supernovaCount: 0,   // 通算超新星回数（=宇宙数）
  // ── 多恒星（Phase 5）──
  // 各恒星は独立した mass/planets を持つ。metaState.mass/planets は activeStarId が指す恒星の鏡。
  // 切替時に _syncActiveStarOut() で stars[] に保存、_syncActiveStarIn() で次の active から読み込む。
  stars: [{ id: 's1', mass: 0, planets: [] }],
  activeStarId: 's1',
  starSlots: 1,
  lastSaved: Date.now(),
  _suspect: false,     // 簡易チート対策: セーブ署名不一致フラグ（将来サーバー検証へ送出）
};

function _metaNum(key, def) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? v : def;
}

// 惑星データの読込＋サニタイズ。未知 key を除外、name を 15 文字に切り、上限スロット数でクランプ。
function _loadPlanets() {
  const validKeys = new Set(CFG.META.PLANET.TYPES.map(t => t.key));
  let arr = [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.META_PLANETS) || '[]');
    if (Array.isArray(raw)) arr = raw;
  } catch (_) { arr = []; }
  const out = [];
  for (const p of arr) {
    if (!p || !validKeys.has(p.key)) continue;
    const name = String(p.name || '').slice(0, 15);
    out.push({ key: p.key, name });
    if (out.length >= CFG.META.PLANET.MAX_SLOTS) break;
  }
  return out;
}
// 恒星リストの読込＋サニタイズ。未保存（旧ユーザー）なら null を返し、呼び出し側で旧 mass/planets から
// 'sN' 形式の id を持つ最初の恒星を作成する。
function _loadStars() {
  const validKeys = new Set(CFG.META.PLANET.TYPES.map(t => t.key));
  let arr = null;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.META_STARS) || 'null');
    if (Array.isArray(raw)) arr = raw;
  } catch (_) { arr = null; }
  if (!arr) return null;
  const max = CFG.META.STAR_SLOTS.MAX;
  const out = [];
  for (const s of arr) {
    if (!s || typeof s.id !== 'string') continue;
    const mass = Math.max(0, Number.isFinite(+s.mass) ? +s.mass : 0);
    const planets = [];
    const ps = Array.isArray(s.planets) ? s.planets : [];
    for (const p of ps) {
      if (!p || !validKeys.has(p.key)) continue;
      planets.push({ key: p.key, name: String(p.name || '').slice(0, 15) });
      if (planets.length >= CFG.META.PLANET.MAX_SLOTS) break;
    }
    out.push({ id: s.id, mass, planets });
    if (out.length >= max) break;
  }
  return out.length > 0 ? out : null;
}

// 多恒星: アクティブ恒星の鏡（metaState.mass/planets）と stars[] を同期するユーティリティ。
function currentStar() {
  return metaState.stars.find(s => s.id === metaState.activeStarId) || metaState.stars[0];
}
// 鏡 → stars[]: 計算系（mass増加・planet追加）の結果を恒星エンティティに書き戻す
function _syncActiveStarOut() {
  const s = currentStar();
  if (!s) return;
  s.mass    = metaState.mass;
  s.planets = metaState.planets.slice();
}
// stars[] → 鏡: 恒星切替時、active 側の値を metaState.mass/planets にコピー
function _syncActiveStarIn() {
  const s = currentStar();
  if (!s) return;
  metaState.mass    = s.mass;
  metaState.planets = s.planets.slice();
}
// 次の恒星枠解放コスト（文明ポイント）。MAX 到達で Infinity。
function nextStarSlotCost() {
  const C = CFG.META.STAR_SLOTS;
  if (metaState.starSlots >= C.MAX) return Infinity;
  // COSTS[N] が N+1 個目の解放コスト（COSTS[0]=0 は初期保有なので未使用）
  return C.COSTS[metaState.starSlots] ?? Infinity;
}
// 恒星枠を1つ解放（文明ポイント消費）。成功で新規恒星 ID を返す（失敗時 null）。
function unlockStarSlot() {
  const cost = nextStarSlotCost();
  if (!Number.isFinite(cost) || metaState.civPoints < cost) return null;
  metaState.civPoints -= cost;
  metaState.starSlots += 1;
  // 新規恒星を末尾に追加（ID は既存と被らない s{N}）
  let n = metaState.stars.length + 1;
  while (metaState.stars.find(s => s.id === 's' + n)) n++;
  const newId = 's' + n;
  metaState.stars.push({ id: newId, mass: 0, planets: [] });
  saveMeta();
  updateResourceBar();
  return newId;
}
// アクティブ恒星を切り替え（鏡を保存→active 変更→新 active を鏡へ）。同 ID なら no-op。
function switchActiveStar(id) {
  if (id === metaState.activeStarId) return false;
  if (!metaState.stars.find(s => s.id === id)) return false;
  _syncActiveStarOut();
  metaState.activeStarId = id;
  _syncActiveStarIn();
  saveMeta();
  return true;
}

// 簡易チート対策: セーブ全体の整合性チェックサム（FNV-1a, 暗号強度なし＝改ざん抑止用）。
// localStorage を手で書き換えると署名が一致しなくなり _suspect フラグが立つ。
function _metaSig() {
  const s = [
    CFG.META.ANTICHEAT.SIG_SALT,
    metaState.stardust, metaState.energy, metaState.mass,
    metaState.genLevel, metaState.civLevel,
    [...metaState.unlockedResearch].sort().join(','),
    metaState.researchPoints,
    metaState.planets.map(p => p.key + ':' + p.name).join(','),
    metaState.civPoints, metaState.supernovaCount,
    metaState.starSlots, metaState.activeStarId,
    // stars[] は active 鏡を更新済み前提でシリアライズ
    metaState.stars.map(s => s.id + '@' + Math.floor(s.mass) + ':' + s.planets.map(p => p.key + ',' + p.name).join('|')).join(';'),
    metaState.lastSaved,
  ].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function loadMeta() {
  const g = CFG.META.GENERATOR, c = CFG.META.CIV;
  metaState.stardust  = Math.max(0, _metaNum(STORAGE_KEYS.META_STARDUST, 0));
  metaState.energy    = Math.max(0, _metaNum(STORAGE_KEYS.META_ENERGY, 0));
  metaState.mass      = Math.max(0, _metaNum(STORAGE_KEYS.META_MASS, 0));
  metaState.genLevel  = Math.min(g.MAX_LEVEL,
                          Math.max(g.START_LEVEL, Math.floor(_metaNum(STORAGE_KEYS.META_GEN_LEVEL, g.START_LEVEL))));
  metaState.civLevel  = Math.min(c.MAX_LEVEL,
                          Math.max(c.START_LEVEL, Math.floor(_metaNum(STORAGE_KEYS.META_CIV_LEVEL, c.START_LEVEL))));
  // 新研究ツリー読込 (game-research.js)
  if (typeof loadResearch === 'function') loadResearch();
  // 惑星: 既知の key のみ採用し、name は 15 文字に切り詰め・上限スロット数でクランプ（サニタイズ）
  metaState.planets = _loadPlanets();
  metaState.civPoints      = Math.max(0, Math.floor(_metaNum(STORAGE_KEYS.META_CIV_POINTS, 0)));
  metaState.supernovaCount = Math.max(0, Math.floor(_metaNum(STORAGE_KEYS.META_SUPERNOVA_CNT, 0)));
  // 多恒星: stars[] が保存されていれば採用、未保存なら旧 mass/planets を 's1' に移行
  const loadedStars = _loadStars();
  if (loadedStars) {
    metaState.stars = loadedStars;
    metaState.activeStarId = localStorage.getItem(STORAGE_KEYS.META_ACTIVE_STAR) || loadedStars[0].id;
    if (!loadedStars.find(s => s.id === metaState.activeStarId)) {
      metaState.activeStarId = loadedStars[0].id;
    }
    metaState.starSlots = Math.max(loadedStars.length,
      Math.min(CFG.META.STAR_SLOTS.MAX, Math.floor(_metaNum(STORAGE_KEYS.META_STAR_SLOTS, 1))));
  } else {
    // 既存ユーザー: 旧 mass/planets を恒星1へ移行
    metaState.stars = [{ id: 's1', mass: metaState.mass, planets: metaState.planets.slice() }];
    metaState.activeStarId = 's1';
    metaState.starSlots = 1;
  }
  // active 鏡をセット（旧 mass/planets を上書き）
  _syncActiveStarIn();
  metaState.lastSaved = _metaNum(STORAGE_KEYS.META_LAST_SAVED, Date.now());

  // 簡易チート対策: 署名検証。不一致＝外部編集の疑い。破壊的措置は取らず
  // フラグを立てつつ Cloudflare ログへビーコン送出（将来のサーバー検証・課金保護のフック）。
  const storedSig = localStorage.getItem(STORAGE_KEYS.META_SIG);
  metaState._suspect = (storedSig !== null && storedSig !== _metaSig());
  if (metaState._suspect) {
    console.warn('[anticheat] meta integrity check failed');
    _reportSuspect('meta_sig_mismatch');
  }

  updateResourceBar();
}

// 簡易チート検知のサーバー通知（fire-and-forget）。Cloudflare ログに出すだけ。
// 同一セッションでの多重送信は防ぐ。
let _reportSent = false;
function _reportSuspect(kind) {
  if (_reportSent) return;
  _reportSent = true;
  try {
    const pid = (typeof getPlayerId === 'function') ? getPlayerId() : null;
    fetch('/api/rollaxy/report', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ player_id: pid, kind }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

function saveMeta() {
  localStorage.setItem(STORAGE_KEYS.META_STARDUST,   String(metaState.stardust));
  localStorage.setItem(STORAGE_KEYS.META_ENERGY,     String(metaState.energy));
  localStorage.setItem(STORAGE_KEYS.META_MASS,       String(metaState.mass));
  localStorage.setItem(STORAGE_KEYS.META_GEN_LEVEL,  String(metaState.genLevel));
  localStorage.setItem(STORAGE_KEYS.META_CIV_LEVEL,  String(metaState.civLevel));
  if (typeof saveResearch === 'function') saveResearch();
  localStorage.setItem(STORAGE_KEYS.META_PLANETS,    JSON.stringify(metaState.planets));
  localStorage.setItem(STORAGE_KEYS.META_CIV_POINTS, String(metaState.civPoints));
  localStorage.setItem(STORAGE_KEYS.META_SUPERNOVA_CNT, String(metaState.supernovaCount));
  // 多恒星: 鏡を恒星エンティティに書き戻してから配列を保存
  _syncActiveStarOut();
  localStorage.setItem(STORAGE_KEYS.META_STARS,      JSON.stringify(metaState.stars));
  localStorage.setItem(STORAGE_KEYS.META_ACTIVE_STAR, metaState.activeStarId);
  localStorage.setItem(STORAGE_KEYS.META_STAR_SLOTS, String(metaState.starSlots));
  localStorage.setItem(STORAGE_KEYS.META_LAST_SAVED, String(metaState.lastSaved));
  localStorage.setItem(STORAGE_KEYS.META_SIG,        _metaSig()); // 整合性署名（簡易チート対策）
}

// ============================================================
// 研究効果の中央集計（拡張ポイント）
// ownedResearch の effect を type ごとに合算。
//   倍率系(rewardMult/scoreMult/starRateMult/genCostMult): 1 + Σvalue を返す
//   加算系(skillCharge/timeBonus): Σvalue を返す
// ============================================================
// getModifier は game-research.js に移行 (新ツリー対応)。ここは空。

// ---- 計算ヘルパー ----
// 質量生成レート (質量/秒) = (MASS_BASE + (level-1)*MASS_PER_LEVEL) × 研究倍率 × 永続成長倍率
function massProdRate(level = metaState.genLevel) {
  const s = CFG.META.STAR;
  return (s.MASS_BASE + (level - 1) * s.MASS_PER_LEVEL)
    * getModifier('starRateMult')
    * getModifier('massGrowthMult');
}
// エネルギー生成レート (energy/秒) = K × mass^(2/3)
function energyRateFromMass(mass) {
  if (mass <= 0) return 0;
  return CFG.META.STAR.ENERGY_K * Math.pow(mass, 2 / 3);
}
// 現在の恒星エネルギー/秒（現在の蓄積質量から）
function starEnergyRate() {
  return energyRateFromMass(metaState.mass);
}
// 恒星の見た目 tier（BODIES index）。TIER_LEVELS の到達レベルから決定。
function starTierBi(level = metaState.genLevel) {
  const tl = CFG.META.STAR.TIER_LEVELS;
  let bi = 0;
  for (let i = 0; i < tl.length; i++) if (level >= tl[i]) bi = i;
  return Math.min(bi, CFG.BODIES.length - 1);
}
// Lv L→L+1 の強化コスト（星屑）。MAX_LEVEL 到達で Infinity。研究で倍率補正。
function generatorCost(level = metaState.genLevel) {
  const g = CFG.META.GENERATOR;
  if (level >= g.MAX_LEVEL) return Infinity;
  const raw = g.BASE_COST * Math.pow(g.GROWTH, level - 1) * getModifier('genCostMult');
  return Math.max(1, Math.floor(raw));
}

// ---- 超新星（Phase 4）----
// 成長% = mass / GROWTH_DIVISOR。CAP_AT 以上は CAP_AT に固定（実値はクランプ済み）。
function growthPct() {
  const sn = CFG.META.SUPERNOVA;
  return metaState.mass / sn.GROWTH_DIVISOR;
}
// 超新星実行可？（成長% ≥ READY_AT）
function canSupernova() {
  return growthPct() >= CFG.META.SUPERNOVA.READY_AT;
}
// 報酬計算: floor(growth/100) * (1 + planets × BONUS_PER_PLANET) × 永続civPointMult。最低 1pt。
function supernovaReward(growth = growthPct(), planetCount = metaState.planets.length) {
  const sn = CFG.META.SUPERNOVA;
  const base = Math.floor(growth / 100);
  const mult = (1 + planetCount * sn.BONUS_PER_PLANET) * getModifier('civPointMult');
  return Math.max(1, Math.floor(base * mult));
}
// 超新星実行: 報酬付与 + 質量・惑星リセット。生成器Lv・研究・星屑/エネは保持。
// 戻り値: 付与された文明ポイント数（0 = 実行不可）。
function doSupernova() {
  settleEnergy();
  if (!canSupernova()) return 0;
  const reward = supernovaReward();
  metaState.civPoints += reward;
  metaState.supernovaCount += 1;
  metaState.mass = 0;
  metaState.planets = [];
  // 超新星実行で研究ポイント獲得 (大Prestige でリセットされない)
  if (typeof awardRpFromSupernova === 'function') awardRpFromSupernova();
  saveMeta();
  updateResourceBar();
  return reward;
}

// ---- 惑星（Phase 3）----
// 解放済み惑星スロット数 = SLOT_LEVELS のうち現在の物質生成器レベル以下の個数。
function unlockedPlanetSlots(level = metaState.genLevel) {
  let n = 0;
  for (const lv of CFG.META.PLANET.SLOT_LEVELS) if (level >= lv) n++;
  return Math.min(n, CFG.META.PLANET.MAX_SLOTS);
}
// 次の惑星生成コスト（星屑）。N 個目 = BASE_COST * COST_GROWTH^(N-1) × 永続planetCostMult。
function nextPlanetCost(count = metaState.planets.length) {
  const p = CFG.META.PLANET;
  const raw = p.BASE_COST * Math.pow(p.COST_GROWTH, count) * getModifier('planetCostMult');
  return Math.max(1, Math.floor(raw));
}
// 惑星を追加できるか（空きスロット＋星屑）。
function canAddPlanet() {
  return metaState.planets.length < unlockedPlanetSlots()
      && metaState.stardust >= nextPlanetCost();
}
// 惑星生成。key=テクスチャ種別, name=表示名。成功で true。
function addPlanet(key, name) {
  const validKeys = new Set(CFG.META.PLANET.TYPES.map(t => t.key));
  if (!validKeys.has(key)) return false;
  if (metaState.planets.length >= unlockedPlanetSlots()) return false;
  const cost = nextPlanetCost();
  if (metaState.stardust < cost) return false;
  metaState.stardust -= cost;
  metaState.planets.push({ key, name: String(name || '').slice(0, 15) });
  saveMeta();
  updateResourceBar();
  return true;
}

// ---- 文明レベル（消費型）----
// Lv L→L+1 のコスト（恒星エネルギー）。MAX_LEVEL 到達で Infinity。
function civLevelCost(level = metaState.civLevel) {
  const c = CFG.META.CIV;
  if (level >= c.MAX_LEVEL) return Infinity;
  return Math.floor(c.BASE_COST * Math.pow(c.GROWTH, level - 1));
}
// 文明レベルを1上げる（恒星エネルギーが足りれば）。戻り値 = 成功可否。
function levelUpCiv() {
  const cost = civLevelCost();
  if (!Number.isFinite(cost)) return false;
  settleEnergy(); // 支払い前に放置分を精算
  if (metaState.energy < cost) return false;
  metaState.energy  -= cost;
  metaState.civLevel += 1;
  saveMeta();
  updateResourceBar();
  return true;
}

// 旧研究関数群は廃止 (game-research.js の buyResearchNode / isResearchUnlocked / getModifier に統合)

// 放置（経過時間）分の質量・エネルギーを精算。時間上限あり（CAP_SEC = 12h）。
// 戻り値 = 今回加算したエネルギー量。
// シンプル計算: エネルギーレートは「精算直前の質量」で固定し、経過秒数を単純に掛ける。
//   energyGain = energyRateFromMass(mass_before) * T
//   massGain   = massProdRate() * T
// ※ 簡易チート対策: 時計巻き戻り(elapsed<0)は 0 に、進め過ぎは CAP_SEC で頭打ち。
function settleEnergy() {
  const now = Date.now();
  let elapsedSec = (now - metaState.lastSaved) / 1000;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) elapsedSec = 0; // 時計巻き戻り対策
  const T = Math.min(elapsedSec, CFG.META.IDLE.CAP_SEC);
  // 放置分の研究ポイントを付与
  if (typeof awardRpFromIdle === 'function') awardRpFromIdle(T);

  // エネルギーレートは精算前の質量で固定（オフライン直前のレート × 時間）
  let energyGain = energyRateFromMass(metaState.mass) * T * getModifier('offlineRateMult');
  if (!Number.isFinite(energyGain) || energyGain < 0) energyGain = 0;

  // 質量増加（超新星ソフトキャップで上限超過時は蓄積停止）
  if (growthPct() < CFG.META.SUPERNOVA.CAP_AT) {
    // 研究効果 offlineRateMult: 経過時間あたりの蓄積を強化（R3）
    metaState.mass += massProdRate() * T * getModifier('offlineRateMult');
    // 上限を超えないようクランプ
    const massCap = CFG.META.SUPERNOVA.CAP_AT * CFG.META.SUPERNOVA.GROWTH_DIVISOR;
    if (metaState.mass > massCap) metaState.mass = massCap;
  }
  metaState.energy  += energyGain;
  metaState.lastSaved = now;
  saveMeta();
  updateResourceBar();
  return energyGain;
}

// プレイ報酬を計算（floor）。modeType = 'time' | 'endless' | 'tutorial'
// stardust = score × STARDUST_PER_SCORE × modeMult × 研究倍率
// ※ エネルギーはゲームからは得られず、恒星（物質生成器）が自動生成する
// maxTier: 今回のプレイで到達した最高 Tier (game.js doGameOver から渡す)
function computeReward(score, modeType, maxTier = 0) {
  const r = CFG.META.REWARD;
  const modeMult = (r.MODE_MULT && r.MODE_MULT[modeType] != null) ? r.MODE_MULT[modeType] : 1;
  const rMult = getModifier('rewardMult'); // 研究による報酬倍率
  // 研究効果 planetBonus: 惑星 1 個あたり + value のボーナス (R3)
  const planetCount = metaState.planets ? metaState.planets.length : 0;
  const planetMult = 1 + planetCount * getModifier('planetBonus');
  // 研究効果 highTierBonus: 高 Tier (>= 7=赤色巨星) に到達するとボーナス
  let tierBonus = 1;
  if (maxTier >= 7) tierBonus = 1 + (maxTier - 6) * getModifier('highTierBonus');
  const mult = modeMult * rMult * planetMult * tierBonus;
  const stardust = Math.floor(score * r.STARDUST_PER_SCORE * mult);
  return { stardust: Math.max(0, stardust) };
}

// プレイ報酬を付与して保存。戻り値 = 付与した報酬 {stardust}。
function grantPlayReward(score, modeType, maxTier = 0) {
  settleEnergy(); // 付与前に放置分を確定（lastSaved 更新）
  const rw = computeReward(score, modeType, maxTier);
  metaState.stardust += rw.stardust;
  // 研究ポイントもスコアから付与
  if (typeof awardRpFromScore === 'function') awardRpFromScore(score);
  saveMeta();
  updateResourceBar();
  return rw;
}

// 物質生成器を1段階強化（星屑が足りれば）。戻り値 = 成功可否。
function upgradeGenerator() {
  const cost = generatorCost();
  if (!Number.isFinite(cost) || metaState.stardust < cost) return false;
  settleEnergy(); // レベル変更でレートが変わるため、その前に精算
  metaState.stardust -= cost;
  metaState.genLevel += 1;
  saveMeta();
  updateResourceBar();
  logEvent('meta_upgrade', { game_id: 'rollaxy', type: 'generator', new_level: metaState.genLevel, cost });
  return true;
}

// ============================================================
// UI — リソースバー（ホーム画面上部の星屑・エネルギー表示）
// ============================================================
function updateResourceBar() {
  const sdEl = document.getElementById('res-stardust-val');
  const enEl = document.getElementById('res-energy-val');
  const cpEl = document.getElementById('res-civpoints-val');
  if (sdEl) sdEl.textContent = Math.floor(metaState.stardust).toLocaleString();
  if (enEl) enEl.textContent = Math.floor(metaState.energy).toLocaleString();
  // 文明ポイントは保有時のみ表示（0 のうちは非表示にして UI を簡潔に保つ）
  const cpWrap = document.getElementById('res-civpoints');
  if (cpEl) cpEl.textContent = Math.floor(metaState.civPoints).toLocaleString();
  if (cpWrap) cpWrap.style.display = metaState.civPoints > 0 ? '' : 'none';
}

// ステージクリア時に報酬パーティクルを飛ばす。
// stardust / energy: 今回獲得した量（粒数の計算に使用）。
function flyRewardParticles(stardust) {
  const sdTarget = document.getElementById('res-stardust');
  if (!sdTarget) return;

  // ソース：画面中央やや下
  const sx = window.innerWidth  / 2;
  const sy = window.innerHeight * 0.52;

  const _flyGroup = (emoji, targetEl, count, groupDelay) => {
    if (count <= 0) return;
    let arrived = 0;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'reward-particle';
      p.textContent = emoji;

      // 発生時の散らばり
      const ox = (Math.random() - 0.5) * 110;
      const oy = (Math.random() - 0.5) * 70 - 10;
      p.style.left    = (sx + ox) + 'px';
      p.style.top     = (sy + oy) + 'px';
      p.style.opacity = '1';
      p.style.transform = 'scale(1)';
      document.body.appendChild(p);

      const flyDelay = groupDelay + i * 55;
      setTimeout(() => {
        const rect = targetEl.getBoundingClientRect();
        const tx = rect.left + rect.width  / 2;
        const ty = rect.top  + rect.height / 2;
        const dur = 0.45 + Math.random() * 0.15;
        p.style.transition = [
          `left ${dur}s cubic-bezier(0.5,0,0.7,1)`,
          `top ${dur}s cubic-bezier(0.5,0,0.7,1)`,
          `opacity 0.18s ${(dur - 0.18).toFixed(2)}s`,
          `transform ${dur}s ease-in`,
        ].join(', ');
        p.style.left      = tx + 'px';
        p.style.top       = ty + 'px';
        p.style.opacity   = '0';
        p.style.transform = 'scale(0.2)';

        setTimeout(() => {
          p.remove();
          arrived++;
          // 最後の粒が到着したらバーをバンプ
          if (arrived === count) {
            targetEl.classList.remove('res-bump');
            void targetEl.offsetWidth; // reflow で animation をリセット
            targetEl.classList.add('res-bump');
            setTimeout(() => targetEl.classList.remove('res-bump'), 400);
          }
        }, (dur + 0.1) * 1000);
      }, flyDelay);
    }
  };

  const nStar = stardust > 0 ? 6 : 0;
  _flyGroup('💫', sdTarget, nStar, 0);
}

// ============================================================
// ============================================================
// ホームカルーセル制御 (0=研究, 1=プレイ, 2=恒星)
// ============================================================
let _carouselIdx = 1;

// カルーセルを指定パネルへ移動（mobile のみアニメーション、desktop は静的3列表示）
function carouselGoTo(idx) {
  _carouselIdx = idx;
  const el = document.getElementById('home-carousel');
  if (!el) return;
  // デスクトップ(≥760px)は CSS で常時3列表示のためtransformしない
  if (window.matchMedia('(min-width: 760px)').matches) return;
  el.style.transform = `translateX(${-idx * 33.3333}%)`;
}

// ============================================================
// UI — cosmos-panel / research-panel
// ============================================================
function _setTxt(id, txt) { const e = document.getElementById(id); if (e) e.textContent = txt; }
function _fmt(n) { return Math.floor(n).toLocaleString(); }

function renderCosmos() {
  if (!document.getElementById('cosmos-3d-wrap')) return;
  // 3D 宇宙ビューアに恒星の見た目を反映（サイズ＝レベル、グロー色＝tier、強度＝レート）
  if (window.Cosmos3D && typeof Cosmos3D.update === 'function') {
    Cosmos3D.update({
      level:      metaState.genLevel,
      tier:       starTierBi(),
      energyRate: starEnergyRate(),
    });
  }
  // 3D に惑星を反映 + 惑星 HUD 行を描画
  if (window.Cosmos3D && typeof Cosmos3D.setPlanets === 'function') {
    Cosmos3D.setPlanets(metaState.planets);
  }
  _renderPlanetRow();
  _renderGrowthRow();
  _renderStarTabs();
  // 質量・残高
  _setTxt('cosmos-mass',     T('massInfo')(_fmt(metaState.mass), massProdRate().toFixed(1)));
  _setTxt('cosmos-rate',     `⚡ +${starEnergyRate().toFixed(2)} ${T('stellarEnergy')}${T('energyRate')}`);
  // 物質生成器
  _setTxt('cosmos-gen-level', T('generatorLevel')(metaState.genLevel));
  const cost = generatorCost();
  const btn  = document.getElementById('cosmos-upgrade-btn');
  if (btn) {
    if (!Number.isFinite(cost)) {
      btn.textContent = T('generatorMax');
      btn.disabled = true;
    } else {
      btn.textContent = `${T('generatorUpgrade')}  💫 ${_fmt(cost)}`;
      btn.disabled = metaState.stardust < cost;
    }
  }
}

// 惑星 HUD 行: 「🪐 惑星 N/スロット数 [＋追加 💫コスト]」を描画。
function _renderPlanetRow() {
  const row = document.getElementById('cosmos-planet-row');
  if (!row) return;
  const slots = unlockedPlanetSlots();
  const count = metaState.planets.length;
  _setTxt('cosmos-planet-count', T('planetCount')(count, slots));
  const addBtn = document.getElementById('cosmos-planet-add');
  if (!addBtn) return;
  if (slots === 0) {
    // まだ1スロットも解放されていない: 次の解放レベルを案内
    addBtn.textContent = T('planetLockedAt')(CFG.META.PLANET.SLOT_LEVELS[0]);
    addBtn.disabled = true;
  } else if (count >= slots) {
    // 全スロット使用中: 次スロット解放レベルを案内（あれば）
    const nextLv = CFG.META.PLANET.SLOT_LEVELS[count];
    addBtn.textContent = nextLv ? T('planetNextSlot')(nextLv) : T('planetSlotsFull');
    addBtn.disabled = true;
  } else {
    const cost = nextPlanetCost();
    addBtn.textContent = `${T('planetAdd')}  💫 ${_fmt(cost)}`;
    addBtn.disabled = metaState.stardust < cost;
  }
}

// 多恒星セレクタ: 横並びタブ + 「+解放」ボタン。アクティブは強調表示。
function _renderStarTabs() {
  const wrap = document.getElementById('cosmos-star-tabs');
  if (!wrap) return;
  const cost = nextStarSlotCost();
  let html = '';
  metaState.stars.forEach((s, i) => {
    const active = s.id === metaState.activeStarId;
    html += `<button class="star-tab${active ? ' active' : ''}" data-star-id="${s.id}">★ ${i + 1}</button>`;
  });
  if (Number.isFinite(cost)) {
    html += `<button id="cosmos-star-unlock" class="star-tab unlock" `
          + `${metaState.civPoints < cost ? 'disabled' : ''}>＋ 🏛️${cost}</button>`;
  }
  wrap.innerHTML = html;
}

// 成長% バー + 超新星ボタン HUD。100% 以上で超新星可、警告閾値で1回ずつトースト。
let _lastWarnedThreshold = 0;
function _renderGrowthRow() {
  const row = document.getElementById('cosmos-growth-row');
  if (!row) return;
  const g = growthPct();
  _setTxt('cosmos-growth-pct', T('growthPct')(g.toFixed(0)));
  const fill = document.getElementById('cosmos-growth-fill');
  if (fill) {
    // 0-100% は通常色、100%超は赤くする。1000%でフル
    const cap = CFG.META.SUPERNOVA.CAP_AT;
    fill.style.width = Math.min(100, (g / cap) * 100).toFixed(1) + '%';
    fill.classList.toggle('ready', g >= CFG.META.SUPERNOVA.READY_AT);
    fill.classList.toggle('unstable', g >= CFG.META.SUPERNOVA.WARN_THRESHOLDS[0]);
  }
  const btn = document.getElementById('cosmos-supernova-btn');
  if (btn) {
    if (canSupernova()) {
      btn.textContent = T('supernovaReady');
      btn.disabled = false;
      btn.classList.add('ready');
    } else {
      btn.textContent = T('supernovaLocked')(Math.max(0, CFG.META.SUPERNOVA.READY_AT - g).toFixed(0));
      btn.disabled = true;
      btn.classList.remove('ready');
    }
  }
  // 警告トースト: WARN_THRESHOLDS のうち、まだ警告していない最大の閾値を超えたら 1回だけ出す
  for (const th of CFG.META.SUPERNOVA.WARN_THRESHOLDS) {
    if (g >= th && _lastWarnedThreshold < th) {
      _lastWarnedThreshold = th;
      _showSupernovaWarning(th);
    }
  }
  // 1000% 到達でソフトキャップ警告
  if (g >= CFG.META.SUPERNOVA.CAP_AT && _lastWarnedThreshold < CFG.META.SUPERNOVA.CAP_AT) {
    _lastWarnedThreshold = CFG.META.SUPERNOVA.CAP_AT;
    _showSupernovaWarning(CFG.META.SUPERNOVA.CAP_AT);
  }
}
function _showSupernovaWarning(threshold) {
  // achievement-toast がいれば再利用、なければ簡易 alert 風
  const msg = threshold >= CFG.META.SUPERNOVA.CAP_AT
    ? T('supernovaCapped')
    : T('supernovaWarn')(threshold);
  if (typeof showAchievementToast === 'function') {
    showAchievementToast({ titleJa: msg, titleEn: msg, titleZh: msg });
  } else {
    console.warn('[supernova]', msg);
  }
}

// ---- 超新星モーダル ----
function openSupernovaModal() {
  if (!canSupernova()) return;
  const modal = document.getElementById('supernova-modal');
  if (!modal) return;
  const reward = supernovaReward();
  _setTxt('supernova-modal-title', T('supernovaModalTitle'));
  _setTxt('supernova-modal-desc',  T('supernovaModalDesc')(growthPct().toFixed(0), metaState.planets.length));
  _setTxt('supernova-modal-reward', `🏛️ +${reward}`);
  const ok = document.getElementById('supernova-modal-ok');
  const ng = document.getElementById('supernova-modal-cancel');
  if (ok) ok.textContent = T('supernovaModalOk');
  if (ng) ng.textContent = T('supernovaModalCancel');
  modal.style.display = 'flex';
}
function closeSupernovaModal() {
  const modal = document.getElementById('supernova-modal');
  if (modal) modal.style.display = 'none';
}
function _confirmSupernova() {
  const reward = doSupernova();
  if (reward <= 0) return;
  closeSupernovaModal();
  // 警告ステートをリセット（次の宇宙ですべての警告がまた出るように）
  _lastWarnedThreshold = 0;
  // 3D 演出
  if (window.Cosmos3D && typeof Cosmos3D.triggerSupernova === 'function') {
    Cosmos3D.triggerSupernova();
  }
  // 残骸フェーズ終わり頃 (新恒星出現の自然なタイミング) に状態を再描画
  setTimeout(() => renderCosmos(), 7000);
}

// ---- 惑星追加モーダル ----
let _planetPickKey = null;
function openPlanetModal() {
  const modal = document.getElementById('planet-modal');
  if (!modal) return;
  if (metaState.planets.length >= unlockedPlanetSlots()) return;
  // テクスチャ選択肢を描画
  const choices = document.getElementById('planet-choices');
  if (choices) {
    _planetPickKey = CFG.META.PLANET.TYPES[0].key; // 既定は先頭
    choices.innerHTML = CFG.META.PLANET.TYPES.map(t =>
      `<button class="planet-choice" data-key="${t.key}">`
      + `<img src="images/cosmos/${t.key}.jpg" alt="${_locName(t)}">`
      + `<span>${_locName(t)}</span></button>`
    ).join('');
  }
  // 既定名 = 種別名 + 連番
  const input = document.getElementById('planet-name-input');
  if (input) {
    const def = CFG.META.PLANET.TYPES[0];
    input.value = `${_locName(def)} ${metaState.planets.length + 1}`;
    input.placeholder = T('planetNamePlaceholder');
  }
  _setTxt('planet-modal-title', T('planetModalTitle'));
  _setTxt('planet-modal-cost', `💫 ${_fmt(nextPlanetCost())}`);
  const addBtn = document.getElementById('planet-modal-add');
  if (addBtn) addBtn.textContent = T('planetModalAdd');
  const cancel = document.getElementById('planet-modal-cancel');
  if (cancel) cancel.textContent = T('planetModalCancel');
  _refreshPlanetChoiceSelection();
  modal.style.display = 'flex';
}
function closePlanetModal() {
  const modal = document.getElementById('planet-modal');
  if (modal) modal.style.display = 'none';
}
function _refreshPlanetChoiceSelection() {
  document.querySelectorAll('.planet-choice').forEach(b => {
    b.classList.toggle('sel', b.dataset.key === _planetPickKey);
  });
}
function _submitPlanetModal() {
  const input = document.getElementById('planet-name-input');
  const name  = input ? input.value.trim() : '';
  if (addPlanet(_planetPickKey, name || _planetPickKey)) {
    closePlanetModal();
    renderCosmos();
  }
}

// 毎秒: 恒星から数値が「絞り出される」演出。3D ビューアの中央付近から +X⚡ を浮かせる。
// （恒星本体の脈動演出は 3D 側 game-cosmos3d.js が担当）
function _tickStarEffect() {
  const wrapEl = document.getElementById('cosmos-3d-wrap');
  if (!wrapEl) return;
  const rate = starEnergyRate();
  if (rate <= 0) return;

  const rect = wrapEl.getBoundingClientRect();
  if (rect.width < 10) return; // パネル非表示中はスキップ
  const p = document.createElement('span');
  p.className = 'energy-float';
  p.textContent = `+${rate.toFixed(2)} ⚡`;
  // 3D ビューア中央やや上から、水平に少しランダムにずらして出現
  const ox = (Math.random() - 0.5) * 44;
  p.style.left = (rect.left + rect.width / 2 + ox) + 'px';
  p.style.top  = (rect.top + rect.height * 0.42) + 'px';
  document.body.appendChild(p);
  setTimeout(() => p.remove(), 1450);
}

let _cosmosTimer = null;
function _startCosmosTick() {
  _stopCosmosTick();
  _cosmosTimer = setInterval(() => {
    settleEnergy();
    renderCosmos();
    _tickStarEffect();
  }, 1000);
}
function _stopCosmosTick() {
  if (_cosmosTimer) { clearInterval(_cosmosTimer); _cosmosTimer = null; }
}

function openCosmos() {
  settleEnergy();
  renderCosmos();
  carouselGoTo(2);
  _startCosmosTick();
}
function closeCosmos() {
  _stopCosmosTick();
  settleEnergy();
  carouselGoTo(1);
}

// ---- 研究オーバーレイ ----
function _locName(o) { const c = (currentLang || 'ja').replace(/^./, x => x.toUpperCase()); return o['name' + c] || o.nameJa; }
function _locDesc(o) { const c = (currentLang || 'ja').replace(/^./, x => x.toUpperCase()); return o['desc' + c] || o.descJa; }

// renderResearch は新研究ツリー (game-research.js) を呼ぶラッパー。
// 旧 normal/perm タブと civLevel 表示は廃止 (R1)。
function renderResearch() {
  if (typeof renderResearchTree === 'function') renderResearchTree();
}

let _researchTimer = null;
function _startResearchTick() {
  _stopResearchTick();
  _researchTimer = setInterval(() => { settleEnergy(); renderResearch(); }, 1000);
}
function _stopResearchTick() {
  if (_researchTimer) { clearInterval(_researchTimer); _researchTimer = null; }
}

// デスクトップ(≥760px)では両パネルが常時表示されるため両方のティックを起動する。
// 重複呼び出しは内部で _stop してから再起動するので安全。
function ensureDesktopTicks() {
  if (!window.matchMedia('(min-width: 760px)').matches) return;
  settleEnergy();
  renderCosmos();
  renderResearch();
  _startCosmosTick();
  _startResearchTick();
}

function openResearch() {
  settleEnergy();
  renderResearch();
  carouselGoTo(0);
  _startResearchTick();
}
function closeResearch() {
  _stopResearchTick();
  settleEnergy();
  carouselGoTo(1);
}

// ---- ランキングオーバーレイ（/api/rollaxy/ranking をネイティブ表示）----
let _rankPeriod = 'daily';
let _rankMode   = 'endless';
function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _rankMyIds() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.SHARE_IDS) || '[]'); } catch (_) { return []; }
}
async function renderRankingHome() {
  const list = document.getElementById('rank-list-home');
  if (!list) return;
  document.querySelectorAll('#rank-period-tabs .rank-period')
    .forEach(b => b.classList.toggle('active', b.dataset.period === _rankPeriod));
  document.querySelectorAll('#rank-mode-tabs .rank-mode')
    .forEach(b => b.classList.toggle('active', b.dataset.mode === _rankMode));
  list.innerHTML = `<div class="rank-status">${T('rankLoading')}</div>`;
  const tz = -(new Date().getTimezoneOffset());
  let entries;
  try {
    const res = await fetch(`/api/rollaxy/ranking?period=${_rankPeriod}&mode=${_rankMode}&limit=50&tz=${tz}`);
    if (!res.ok) throw new Error('http');
    entries = (await res.json()).entries || [];
  } catch (_) {
    list.innerHTML = `<div class="rank-status error">${T('rankError')}</div>`;
    return;
  }
  if (!entries.length) { list.innerHTML = `<div class="rank-status">${T('rankEmpty')}</div>`; return; }
  const mine = _rankMyIds();
  let html = '';
  for (const e of entries) {
    const isMine = mine.includes(e.id);
    const rc = e.rank === 1 ? 'top1' : e.rank === 2 ? 'top2' : e.rank === 3 ? 'top3' : '';
    const tier = Math.min(CFG.BODIES.length - 1, Math.max(0, e.highest_body_tier | 0));
    const emoji = (CFG.BODIES[tier] || {}).e || '✨';
    const name = e.display_name ? _esc(e.display_name) : '—';
    const date = new Date(e.created_at * 1000).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    html += `<div class="rank-card${isMine ? ' is-mine' : ''}">`
          + `<div class="rc-rank ${rc}">#${e.rank}</div>`
          + `<div class="rc-body">${emoji}</div>`
          + `<div class="rc-main"><div class="rc-player">${name}${isMine ? ' 👤' : ''}</div>`
          + `<div class="rc-score">${Number(e.score).toLocaleString()}</div></div>`
          + `<div class="rc-date">${date}</div></div>`;
  }
  list.innerHTML = html;
}
function openRankingHome() {
  renderRankingHome();
  document.getElementById('ranking-overlay')?.classList.add('show');
}
function closeRankingHome() {
  document.getElementById('ranking-overlay')?.classList.remove('show');
}

// ============================================================
// 初期化・イベント配線（スクリプトは body 末尾のため DOM 構築済み）
// ============================================================
loadMeta();
// オフライン報酬: 質量のみ先に精算し、エネルギーは保留してモーダルで「受け取る」ボタンを表示。
let _pendingOfflineEnergy = 0;
(function _initOfflineReward() {
  const now = Date.now();
  let elapsedSec = (now - metaState.lastSaved) / 1000;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) elapsedSec = 0;
  const T = Math.min(elapsedSec, CFG.META.IDLE.CAP_SEC);

  // エネルギー獲得量を計算（まだ加算しない）
  let energyGain = energyRateFromMass(metaState.mass) * T * getModifier('offlineRateMult');
  if (!Number.isFinite(energyGain) || energyGain < 0) energyGain = 0;

  // 質量は即時反映・lastSaved 更新（エネルギーは保留）
  // 超新星ソフトキャップ: 1000% 以上は蓄積停止
  if (growthPct() < CFG.META.SUPERNOVA.CAP_AT) {
    // 研究効果 offlineRateMult: 経過時間あたりの蓄積を強化（R3）
    metaState.mass += massProdRate() * T * getModifier('offlineRateMult');
    const massCap = CFG.META.SUPERNOVA.CAP_AT * CFG.META.SUPERNOVA.GROWTH_DIVISOR;
    if (metaState.mass > massCap) metaState.mass = massCap;
  }
  metaState.lastSaved = now;
  saveMeta();
  updateResourceBar();

  // 1分以上放置 & 1以上の獲得があればモーダル表示
  if (elapsedSec >= 60 && energyGain >= 1) {
    _pendingOfflineEnergy = energyGain;
    _showOfflineRewardModal(elapsedSec, energyGain);
  }
})();

// オフライン報酬モーダルを表示
function _showOfflineRewardModal(elapsedSec, energyGain) {
  const modal = document.getElementById('offline-reward-modal');
  if (!modal) return;

  const totalMin = Math.floor(elapsedSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  document.getElementById('offline-reward-title').textContent   = T('offlineTitle');
  document.getElementById('offline-reward-duration').textContent = T('offlineDuration')(h, m);
  document.getElementById('offline-reward-label').textContent   = T('offlineEnergyLabel');
  document.getElementById('offline-reward-amount').textContent  = '+' + _fmt(Math.floor(energyGain));
  document.getElementById('offline-reward-collect-btn').textContent = T('offlineCollectBtn');

  modal.style.display = 'flex';
}

// 「受け取る」ボタン: エネルギー付与 → パーティクル → モーダル閉じる
function _collectOfflineReward() {
  if (_pendingOfflineEnergy <= 0) return;
  metaState.energy += _pendingOfflineEnergy;
  _pendingOfflineEnergy = 0;
  saveMeta();
  updateResourceBar();

  // エネルギーパーティクルをモーダルの受け取るボタン付近から #res-energy へ飛ばす
  const target = document.getElementById('res-energy');
  const btn    = document.getElementById('offline-reward-collect-btn');
  if (target && btn) {
    const tRect = target.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    const sx = bRect.left + bRect.width  / 2;
    const sy = bRect.top  + bRect.height / 2;
    const tx = tRect.left + tRect.width  / 2 - sx;
    const ty = tRect.top  + tRect.height / 2 - sy;
    const count = Math.min(18, Math.max(6, Math.floor(metaState.energy / 50)));
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'energy-particle';
      p.textContent = '⚡';
      const spread = 40;
      const ox = (Math.random() - 0.5) * spread;
      const oy = (Math.random() - 0.5) * spread;
      const dur = 0.5 + Math.random() * 0.35;
      const delay = i * 0.03;
      p.style.cssText = `left:${sx + ox}px; top:${sy + oy}px;`
        + `--tx:${tx - ox}px; --ty:${ty - oy}px; --dur:${dur}s;`
        + `animation-delay:${delay}s;`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), (dur + delay + 0.1) * 1000);
    }
  }

  // モーダルを閉じる
  const modal = document.getElementById('offline-reward-modal');
  if (modal) modal.style.display = 'none';
}

// オフライン報酬モーダルの「受け取る」ボタン
on(document.getElementById('offline-reward-collect-btn'), () => _collectOfflineReward());

// ※ 下部バーのタブ切替（恒星/研究/実績/ランキング/プレイ）は game.js の showHomeTab() が統括。
//    ここでは各パネル内の操作だけ配線する。
on(document.getElementById('cosmos-upgrade-btn'), () => {
  if (upgradeGenerator()) { playUpgradeSound(); renderCosmos(); }
});

// 惑星追加: HUD の「＋追加」ボタン → モーダル → 種別選択/命名 → 生成
on(document.getElementById('cosmos-planet-add'), () => openPlanetModal());
on(document.getElementById('planet-modal-cancel'), () => closePlanetModal());
on(document.getElementById('planet-modal-add'), () => _submitPlanetModal());
const _planetChoicesEl = document.getElementById('planet-choices');
if (_planetChoicesEl) {
  _planetChoicesEl.addEventListener('click', (e) => {
    const b = e.target.closest('.planet-choice');
    if (!b) return;
    _planetPickKey = b.dataset.key;
    _refreshPlanetChoiceSelection();
  });
}
// 背景クリックで閉じる
on(document.getElementById('planet-modal'), (e) => {
  if (e.target === document.getElementById('planet-modal')) closePlanetModal();
});

// 多恒星: 恒星セレクタタブのクリックをデリゲート。「+解放」は文明ポイントを消費して枠追加。
const _starTabsEl = document.getElementById('cosmos-star-tabs');
if (_starTabsEl) {
  _starTabsEl.addEventListener('click', (e) => {
    const t = e.target.closest('.star-tab');
    if (!t || t.disabled) return;
    if (t.id === 'cosmos-star-unlock') {
      const newId = unlockStarSlot();
      if (newId) {
        switchActiveStar(newId);
        renderCosmos();
      }
      return;
    }
    const id = t.dataset.starId;
    if (id) {
      switchActiveStar(id);
      renderCosmos();
    }
  });
}

// 超新星: HUD の「超新星」ボタン → 確認モーダル → 実行
on(document.getElementById('cosmos-supernova-btn'), () => openSupernovaModal());
on(document.getElementById('supernova-modal-cancel'), () => closeSupernovaModal());
on(document.getElementById('supernova-modal-ok'), () => _confirmSupernova());
on(document.getElementById('supernova-modal'), (e) => {
  if (e.target === document.getElementById('supernova-modal')) closeSupernovaModal();
});
// 旧文明レベル up ボタンの配線は廃止 (R1: civLevel 自体が廃止)
// ランキング期間タブ
document.querySelectorAll('#rank-period-tabs .rank-period').forEach((btn) => {
  on(btn, () => { _rankPeriod = btn.dataset.period; renderRankingHome(); });
});
document.querySelectorAll('#rank-mode-tabs .rank-mode').forEach((btn) => {
  on(btn, () => { _rankMode = btn.dataset.mode; renderRankingHome(); });
});
const _researchListEl = document.getElementById('research-list');
if (_researchListEl) {
  _researchListEl.addEventListener('click', (e) => {
    // R2: 新ツリー UI は .research-node が購入トリガー
    const node = e.target.closest('.research-node');
    if (!node) return;
    if (typeof buyResearchNode === 'function' && buyResearchNode(node.dataset.id)) {
      playUpgradeSound();
      renderResearch();
    }
  });
}

// 言語切替時、ホーム画面が表示中なら動的コンテンツを再描画
document.addEventListener('langchange', () => {
  if (!document.getElementById('start-screen')?.classList.contains('hidden')) {
    renderCosmos();
    renderResearch();
  }
  const rkv = document.getElementById('ranking-overlay');
  if (rkv && rkv.classList.contains('show')) renderRankingHome();
});
