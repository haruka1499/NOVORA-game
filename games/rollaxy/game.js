'use strict';

// ============================================================
// ころころ宇宙 — game.js
//
// 【ユーザーの表現 → コード対応表】
//   「天体」              → CFG.BODIES[bi] の各要素 / Matter.js の circle body (label:'celestial')
//   「次の天体（が表示されているところ）」→ #next-wrap / #next-emoji / 変数 nxtBi
//   「合成」              → 同種天体が接触 → onColl/scanNearby → flushMerges で1段階上を生成
//   「合成時に少し光る仕様」→ glowMap + paintBody 内の glow ブロック（縁が光るエフェクト）
//   「ゲームオーバー時のオーバーレイ」→ #overlay（dead=true 時に .show で表示）
//   「設定を開いたとき（の画面）」→ #settings-overlay（paused=true 時に .show で表示）
//   「設定ボタン」        → #settings-btn（ヘッダー右端の ⚙ ボタン）
//   「ゲームに戻る」      → closeSettings()（paused を解除して #settings-overlay を閉じる）
//   「リセット」          → init()（物理エンジン・スコア・天体を全初期化→スタート画面へ）
//   「スタート画面」      → #start-screen（canvas外の独立レイヤー。ページ読み込み・リトライ・リセット後に表示）
//   「爆弾スキル」        → activeSkill='bomb' / bombMode=true / bombBody（物理ボディ）
//   「指定アップグレード（強化スキル）」→ activeSkill='upgrade' / skillSelectMode=true
//   「指定削除スキル」    → activeSkill='delete'  / skillSelectMode=true
//   「天体選択モード」    → skillSelectMode=true（upgrade/delete 選択中、canvas tap で天体を選ぶ）
//
// 【スマホ向け設計の要点】
//   - canvas は論理サイズ 400×700px 固定。resize() が CSS transform:scale で画面にフィット。
//   - 入力は mousemove/click と touchmove/touchend の両方を登録（PC・スマホ共用）。
//   - touchmove は preventDefault() で引っ張りスクロールを防ぐため passive:false が必要。
//   - 各ボタンに click と touchend を両方登録（iOS の 300ms click 遅延を回避）。
// ============================================================

// ============================================================
// DOM
// ============================================================
const canvas      = document.getElementById('game');
const ctx         = canvas.getContext('2d');
const outer       = document.getElementById('canvas-outer');

// デバイスピクセル比（Retina / 高DPI 対応）。3倍超はパフォーマンス重視で上限を設ける
const _dpr = Math.min(window.devicePixelRatio || 1, 3);

// 「ゲームオーバー時のオーバーレイ」= #overlay
const overlay     = document.getElementById('overlay');
const scoreEl     = document.getElementById('score-el');
const hiEl        = document.getElementById('hi-el');
// 「次の天体が表示されているところ」の絵文字部分 = #next-emoji
const nextEmoEl   = document.getElementById('next-emoji');
const finalEl     = document.getElementById('final-score');
const newHiEl     = document.getElementById('new-hi');
const retryBtn    = document.getElementById('retry-btn');
const _overlayTitleEl = overlay.querySelector('h2'); // ゲームオーバー/クリアのタイトル出し分け用
const modeToggleBtn   = document.getElementById('mode-toggle-btn'); // スタート画面のモード切替

// 「設定ボタン」= #settings-btn / 「設定を開いたとき」= #settings-overlay
const settingsBtn     = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const menuPanel       = document.getElementById('menu-panel');
const settingsPanel   = document.getElementById('settings-panel');
const resumeBtn       = document.getElementById('resume-btn');       // 「ゲームに戻る」
const menuSettingsBtn = document.getElementById('menu-settings-btn'); // メニュー内「設定」
const settingsBackBtn = document.getElementById('settings-back-btn'); // 設定内「← 戻る」
const resetBtn        = document.getElementById('reset-btn');         // 「リセット」

// 「スタート画面」= #start-screen（canvas外の独立レイヤー）
const startScreen       = document.getElementById('start-screen');
const startBtn          = document.getElementById('start-btn');
const startPlayernameEl  = document.getElementById('start-playername-val');
const startNameView      = document.getElementById('start-name-view');
const startNameEditor    = document.getElementById('start-name-editor');
const startNameInput     = document.getElementById('start-name-input');
const startNameEditBtn   = document.getElementById('start-name-edit-btn');
const startNameSaveBtn   = document.getElementById('start-name-save-btn');
const startNameCancelBtn = document.getElementById('start-name-cancel-btn');
const startNameHint      = document.getElementById('start-name-hint');
const startNameHintOkBtn = document.getElementById('start-name-hint-ok');

// スタート画面のプレイヤー名を更新
function updateStartPlayername() {
  if (startPlayernameEl) startPlayernameEl.textContent = getDisplayName();
}

// 初回訪問ヒントの表示・テキスト更新（langchange 時にも呼ぶ）
function updateNameHint() {
  if (!startNameHint) return;
  if (localStorage.getItem(STORAGE_KEYS.HINT_SHOWN)) {
    hide(startNameHint);
    return;
  }
  const msgEl = document.getElementById('start-name-hint-msg');
  if (msgEl) msgEl.textContent = T('startNameHint');
  if (startNameHintOkBtn) startNameHintOkBtn.textContent = T('startNameHintOk');
  show(startNameHint);
}

function _dismissNameHint() {
  localStorage.setItem(STORAGE_KEYS.HINT_SHOWN, '1');
  if (startNameHint) hide(startNameHint);
}

on(startNameHintOkBtn, _dismissNameHint);

function _openStartNameEditor() {
  if (startNameInput) {
    startNameInput.value       = '';
    startNameInput.placeholder = getDisplayName(); // 現在のデフォルト名をプレースホルダーに
  }
  startNameView.style.display   = 'none';
  startNameEditor.style.display = 'flex';
  if (startNameInput) startNameInput.focus();
}

function _closeStartNameEditor() {
  startNameView.style.display   = 'flex';
  startNameEditor.style.display = 'none';
}

function _saveStartName() {
  // 空のまま確定 → プレースホルダーのデフォルト名を採用
  const raw = (startNameInput && startNameInput.value.trim()) || getDisplayName();
  if (saveDisplayName(raw)) syncDisplayNameToServer();
  updateStartPlayername();
  _closeStartNameEditor();
  _dismissNameHint();
}

on(startNameEditBtn,   _openStartNameEditor);
on(startNameSaveBtn,   _saveStartName);
on(startNameCancelBtn, _closeStartNameEditor);
on(startNameHint,      _openStartNameEditor);
startNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  _saveStartName();
  if (e.key === 'Escape') _closeStartNameEditor();
});

// 「連鎖表示」= #chain-display（2連鎖以上でポップアップ）
const chainEl = document.getElementById('chain-display');

// ============================================================
// スキル使用通知（game-skills.js から呼ぶ）
// スキル連鎖判定ウィンドウを開く
// ============================================================
function notifySkillUsed() {
  _skillJustUsed = true;
  _skillChainBonus = true;
  clearTimeout(_skillChainBonusTimer);
  _skillChainBonusTimer = setTimeout(() => {
    _skillChainBonus = false;
    _skillChainBonusTimer = null;
  }, CFG.RULES.CHAIN_WINDOW_MS);
}

// ============================================================
// 連鎖スコア演出: 連鎖終了時にベーススコア × 各ステップ倍率を高速再現
// ============================================================
function _playChainScoreAnim(baseSc, finalCount, isSkill) {
  const el = document.getElementById('chain-score-anim');
  if (!el || baseSc <= 0) return;

  // 最大6ステップ表示（連鎖数が多い場合は後半6連鎖分のみ）
  const startN = Math.max(2, finalCount - 5);

  el.classList.remove('csa-show');
  void el.offsetWidth;
  el.classList.add('csa-show');

  let n = startN;
  const tick = () => {
    const cm   = _chainMultiplier(n);
    const tm   = +(cm * (isSkill ? 2 : 1)).toFixed(4);
    const multStr = isSkill ? `×${cm.toFixed(1)} ×2` : `×${cm.toFixed(1)}`;
    const isFinal = n === finalCount;
    if (isFinal) {
      const result = Math.floor(baseSc * tm);
      el.innerHTML =
        `<span class="csa-base">${baseSc}</span>`
        + `<span class="csa-mult csa-final${isSkill ? ' csa-skill' : ''}">${multStr}</span>`
        + `<span class="csa-eq"> = +${result}</span>`;
      setTimeout(() => el.classList.remove('csa-show'), 1500);
    } else {
      el.innerHTML =
        `<span class="csa-base">${baseSc}</span>`
        + `<span class="csa-mult${isSkill ? ' csa-skill' : ''}">${multStr}</span>`;
      n++;
      setTimeout(tick, 75);
    }
  };
  tick();
}

// リソースバー (星屑/エネルギー/文明P) は廃止。互換のため呼び出し側のために no-op を残す。
function showResourceBar() {}
function hideResourceBar() {}

// ── 起動時クリーンアップ: 研究/宇宙関連の旧 localStorage キーを一括削除 ──
// 廃止された機能のデータが残るとロード時に混乱するため、起動の最初に削除する。
// ハイスコア・実績・チュートリアル進捗・統計・設定などプレイに関係するものは残す。
(function _cleanupDeprecatedMeta() {
  const deprecated = [
    'rollaxy_stardust',
    'rollaxy_stellar_energy',
    'rollaxy_meta_mass',
    'rollaxy_generator_level',
    'rollaxy_civ_level',
    'rollaxy_civ_points',
    'rollaxy_supernova_count',
    'rollaxy_meta_last_saved',
    'rollaxy_meta_sig',
    'rollaxy_research',
    'rollaxy_perm_research',
    'rollaxy_research_tree',
    'rollaxy_research_points',
    'rollaxy_planets',
    'rollaxy_stars',
    'rollaxy_active_star',
    'rollaxy_star_slots',
  ];
  for (const k of deprecated) localStorage.removeItem(k);
})();

// ============================================================
// 天体カスタム画像（絵文字の代わりに PNG を使う天体）
// bodyImages[bi] に Image オブジェクトをセットすると、その bi の天体に画像が使われる
// ============================================================
const bodyImages = new Array(CFG.BODIES.length).fill(null);
(function () {
  CFG.BODIES.forEach((def, bi) => {
    const img = new Image();
    img.onload = () => { try { updateHUD(); } catch (_) {} };
    img.src = `images/${def.key}.png`;
    bodyImages[bi] = img;
  });
})();

// ============================================================
// STATE
// ============================================================
let eng, world;
let score, dangerCnt;
let dead;    // true = ゲームオーバー（物理停止・描画は継続・#overlay 表示）
let paused;  // true = 設定中（物理停止・描画は継続・#settings-overlay 表示）
let waiting; // true = スタート待ち（物理停止・描画は継続・#start-screen 表示）
let curBi, nxtBi, dropX, canDrop, dropTimer;
// R3 previewLength: nxtBi より先の天体を先読みするキュー (空なら通常動作)
let _previewLookahead = [];
function _maintainPreviewLookahead() {
  const want = (typeof getModifier === 'function') ? Math.max(0, Math.floor(getModifier('previewLength'))) : 0;
  while (_previewLookahead.length < want) _previewLookahead.push(rnd());
  if (_previewLookahead.length > want) _previewLookahead.length = want;
}
let bmap;    // Map<bodyId, {bi, at, body}>  ※ at = スポーン時刻(ms)
let mq;      // merge queue: 合成待ちペアのリスト
let glowMap; // Map<bodyId, {endTime, duration}> — 「合成時に少し光る仕様」のエフェクト管理

let chainCount;       // 連鎖カウント（1回目の合成で1、以降ウィンドウ内に続けば加算）
let chainTimer;       // 700ms 連鎖ウィンドウタイマー（新しい合成で clearTimeout される）
let chainResolveTimer; // 750ms 演出+報酬タイマー（新しい合成で cancel されてはいけない）

// ---- 連鎖倍率スコア ----
let _chainBaseScore      = 0;    // 連鎖中のベーススコア蓄積バッファ
let _isSkillChain        = false; // スキル起点の連鎖か（終了時に×2）
let _skillChainBonus     = false; // スキル使用後800ms以内か（triggerChain で判定）
let _skillChainBonusTimer = null; // _skillChainBonus の自動解除タイマー

// フィボナッチ倍率シーケンス: SEQ[0]=chain2ボーナス(0.1), SEQ[1]=chain3(0.2), SEQ[n]=SEQ[n-1]+SEQ[n-2]
const _CHAIN_BONUS_SEQ = (() => {
  const seq = [0.1, 0.2];
  while (seq.length < 30) {
    const l = seq.length;
    seq.push(+(seq[l - 1] + seq[l - 2]).toFixed(6));
  }
  return seq;
})();
// chain n の倍率: n<=1→×1.0, n=2→×1.1, n=6→×1.8, n=7→×2.3 ...
function _chainMultiplier(n) {
  if (n <= 1) return 1.0;
  const bonus = _CHAIN_BONUS_SEQ[Math.min(n - 2, _CHAIN_BONUS_SEQ.length - 1)];
  // R3: 研究効果 chainMultBonus を加算 (n>=3 から適用)
  const extra = (typeof getModifier === 'function' && n >= 3)
    ? (getModifier('chainMultBonus') - 1) * (n - 2)  // 連鎖が深いほど効く
    : 0;
  return +(1 + bonus + extra).toFixed(4);
}

// ---- スキル状態 ----
let activeSkill;    // null | 'bomb' | 'upgrade' | 'delete'
let bombMode;       // true = 爆弾が落下待機中（curBi の代わりに爆弾を落とす）
let bombBody;       // 爆弾の Matter.js ボディ（投下後に存在）
let bombHit;        // true = 爆弾が衝突済み（導火線カウント中）
let bombFuseTimer;  // 爆発タイムアウト ID
let bombExplosion;  // 爆発エフェクト状態 {x, y, startTime, duration} | null

let skillSelectMode; // true = upgrade/delete の天体選択モード中
let skillSelectedId; // 選択済み bodyId（確認パネル表示中）
let skillCharges;    // {bomb, upgrade, delete} — 現在の所持数

let chainRewardPending; // true = 5連鎖報酬パネル表示中
let rouletteActive;    // true = ルーレット表示中
const rouletteQueue = [];   // ルーレット待機キュー（rouletteActive 中でも積める）
let pendingChoiceRewards = 0; // 未受け取り5連鎖報酬数
let choiceAutoShow = true;   // 報酬パネルを自動表示するか（設定でトグル可）
let choiceAutoTimer = null;  // 自動非表示タイマー
let choicePeekTimer = null;  // 短時間ピーク演出タイマー

// ---- チュートリアル / 強制スキル使用 ----
let tutorialDone = !!localStorage.getItem(STORAGE_KEYS.TUTORIAL_DONE);
let tutorialActive = false;     // チュートリアル強制使用モード中
let tutorialTargetId = null;    // ポインターが指す天体ID
let _forcedSkillActive = false; // 4連鎖後の強制即時使用待ち中

// ---- チュートリアル案内ポインター（操作が止まると目標に応じて案内） ----
let _idleLastInput     = 0;     // 最後のユーザー操作時刻
let _objPointerActive  = false; // 案内ポインター表示中
const OBJ_POINTER_IDLE_MS = 2500; // この時間操作が止まると案内を出す

// ---- リマインダー追跡（セッション単位） ----
let _session5ChainCount   = 0;     // 今セッションの5連鎖報酬付与回数
let _sessionEverClaimed   = false; // 一度でも報酬を選択したか
let _sessionEverUsedSkill = false; // 一度でも自分でスキルを使ったか

// ---- ポインター座標変換キャッシュ ----
let _canvasScale   = 1;
let _canvasOffsetX = 0;

// ---- デバッグモード状態 ----
let debugMode    = false; // ` キーでトグル
let debugBi      = 0;     // パレットで選択中の天体インデックス
let debugDragging = false; // 左ボタン押しっぱなし中

// korokoro_hi は旧キー名。rollaxy_hi に移行済みなら旧キーは無視される。
let hiScore     = +(localStorage.getItem(STORAGE_KEYS.HI_SCORE)       || localStorage.getItem(STORAGE_KEYS.LEGACY_HI) || 0);
let hiScoreTime = +(localStorage.getItem(STORAGE_KEYS.BEST_SCORE_TIME) || 0);
hiEl.textContent = `${T('best')}: ${hiScore}`;

// ============================================================
// GAME MODE — モード/ステージの状態と土台（config.js の MODES/STAGES と連動）
// ============================================================
// currentModeId: 'tutorial' | 'time' | 'endless'。currentStageId は tutorial モード時のみ使用。
// チュートリアル未完了なら強制的に 'tutorial'。完了後は最後に選んだモードを復元
// （無効値・未解禁・tutorial を指していたらデフォルト 'time' へフォールバック）。
function isStageTutorialDone() {
  return !!localStorage.getItem(STORAGE_KEYS.STAGE_TUTORIAL_DONE);
}
let currentModeId;
if (!isStageTutorialDone()) {
  currentModeId = 'tutorial';
} else {
  currentModeId = localStorage.getItem(STORAGE_KEYS.LAST_MODE) || CFG.DEFAULT_MODE;
  const _m = CFG.MODES.find(m => m.id === currentModeId);
  if (!_m || _m.type === 'tutorial') currentModeId = CFG.DEFAULT_MODE;
}
let currentStageId = null; // tutorial モード時に firstUnclearedStageId() で確定
let _endIsClear    = false; // 直近の終了がステージクリアか（オーバーレイ表示の出し分け用）
let _endReason     = 'gameover'; // 'gameover' | 'timeup' | 'clear' — オーバーレイ見出しの出し分け用

const curMode  = () => CFG.MODES.find(m => m.id === currentModeId) || CFG.MODES[0];
const curStage = () => CFG.STAGES.find(s => s.id === currentStageId) || null;

// プレイヤーレベル（将来のモード/ステージ解禁用のスタブ。今は常に 0）。
function getPlayerLevel() {
  return parseInt(localStorage.getItem(STORAGE_KEYS.PLAYER_LEVEL) || '0', 10) || 0;
}
// 解禁判定の唯一の入口。将来はここにレベル/前ステージクリア条件を足すだけで拡張できる。
// モード/ステージの解放判定。
// モード:
//   - tutorial / endless は常に解放
//   - speedrun: 中性子星(bi=8)作成で解放
//   - time: 銀河団(bi=11)達成で解放
//   - その他: 既存の unlockLevel 互換
function isUnlocked(item) {
  if (item && typeof item.id === 'string') {
    if (item.id === 'endless' || item.id === 'tutorial') return true;
    if (item.id === 'speedrun' || item.id === 'time') return isModeUnlocked(item.id);
  }
  return (item?.unlockLevel ?? 0) <= getPlayerLevel();
}
function getUnlockedModes() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.UNLOCKED_MODES) || '[]')); }
  catch (_) { return new Set(); }
}
function isModeUnlocked(modeId) {
  return getUnlockedModes().has(modeId);
}
// 新規モード解放。既に解放済なら何もしない。ポップアップ表示はオプション (showPopup=true)。
function unlockMode(modeId, showPopup = true) {
  const s = getUnlockedModes();
  if (s.has(modeId)) return false;
  s.add(modeId);
  localStorage.setItem(STORAGE_KEYS.UNLOCKED_MODES, JSON.stringify([...s]));
  if (showPopup) showModeUnlockPopup(modeId);
  return true;
}
// flushMerges / 強化スキル両経路から呼ばれる解放判定。
// 中性子星(bi=8) 作成 → エンドレスでプレイ中なら speedrun 解放
// 銀河団(bi=11) 達成 → エンドレス/スピードランのいずれでも time 解放
function _checkModeUnlock(bi) {
  const m = curMode()?.type;
  if (bi === 8 && m === 'endless' && !isModeUnlocked('speedrun')) {
    unlockMode('speedrun');
  }
  if (bi === 11 && (m === 'endless' || m === 'speedrun') && !isModeUnlocked('time')) {
    unlockMode('time');
  }
}

// ── モード解放ポップアップ ──
// 表示中は paused = true でシミュレーション停止 (speedrun クリア演出の最中でも安全)。
// 閉じるボタン or 背景タップで paused 解除 + ポップアップ非表示。
function showModeUnlockPopup(modeId) {
  const modal  = document.getElementById('mode-unlock-modal');
  const title  = document.getElementById('mode-unlock-title');
  const closeB = document.getElementById('mode-unlock-close');
  if (!modal) return;
  // モード名を i18n で取得
  const def = CFG.MODES.find(m => m.id === modeId);
  const modeNm = def ? modeName(def) : modeId;
  if (title) title.textContent = T('modeUnlocked')(modeNm);
  if (closeB) closeB.textContent = T('modeUnlockClose');
  // 時間停止 (ポーズ計測も連動)
  if (!paused) {
    paused = true;
    if (typeof _onPauseStart === 'function') _onPauseStart();
  }
  modal.classList.add('show');
}
function _closeModeUnlockPopup() {
  const modal = document.getElementById('mode-unlock-modal');
  if (modal) modal.classList.remove('show');
  // 時間再開 (dead 中はそのまま、ゲームプレイ中だけ paused 解除)
  if (paused && !dead) {
    paused = false;
    if (typeof _onPauseEnd === 'function') _onPauseEnd();
  }
}
// 現在言語でモード名を取得（achievements と同じ nameJa/En/Zh 規約）。
function modeName(m) {
  const cap = (typeof currentLang === 'string' ? currentLang : 'ja').replace(/^./, c => c.toUpperCase());
  return m[`name${cap}`] || m.nameJa;
}
// クリア済みステージ集合の読み書き（rollaxy_stage_cleared に JSON 配列で保存）。
function loadClearedStages() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.STAGE_CLEARED) || '[]')); }
  catch (_) { return new Set(); }
}
function markStageCleared(id) {
  if (!id) return;
  const set = loadClearedStages();
  set.add(id);
  localStorage.setItem(STORAGE_KEYS.STAGE_CLEARED, JSON.stringify([...set]));
}
// 未クリアの先頭ステージ ID を返す。全てクリア済みなら最終ステージを返す（再挑戦可能）。
function firstUnclearedStageId() {
  const cleared = loadClearedStages();
  const next = CFG.STAGES.find(s => !cleared.has(s.id));
  return (next || CFG.STAGES[CFG.STAGES.length - 1] || null)?.id ?? null;
}
// 現在のステージ目標が達成されているか（複数条件は全て満たす必要がある）。
function isObjectiveMet(st) {
  if (!st) return false;
  if (st.goalScore       != null && score < st.goalScore)                         return false;
  if (st.requireSkill    != null && !_skillUsedTypes.has(st.requireSkill))        return false;
  if (st.requireAnySkill != null && _skillUsedTypes.size < st.requireAnySkill)    return false;
  if (st.requireTier     != null && _maxTierThisGame < st.requireTier)            return false;
  if (st.requireSkillCount != null) {
    const { skill, count } = st.requireSkillCount;
    if ((_skillUsedCounts[skill] || 0) < count) return false;
  }
  if (st.requireAllSkills != null) {
    for (const [skill, count] of Object.entries(st.requireAllSkills)) {
      if ((_skillUsedCounts[skill] || 0) < count) return false;
    }
  }
  return true;
}
// 現在ステージの目標説明（現在言語）。
function stageDesc(st) {
  if (!st) return '';
  const cap = (typeof currentLang === 'string' ? currentLang : 'ja').replace(/^./, c => c.toUpperCase());
  return st[`desc${cap}`] || st.descJa || '';
}
// スキルアイコン文字列（チュートリアルHUD進捗表示用）
function _skillIcon(skill) {
  return skill === 'bomb' ? '💣' : skill === 'upgrade' ? '⬆️' : '✕';
}

// スキル使用を記録（チュートリアル目標判定用）。game.js/game-skills.js から呼ぶ。
function noteSkillUsed(type) {
  if (!type) return;
  _skillUsedTypes.add(type);
  _skillUsedCounts[type] = (_skillUsedCounts[type] || 0) + 1;
  updateStageObjective(); // プログレス表示を即時更新
}

// 研究効果（メタ）の取得ラッパー。game-meta.js 未ロードでも安全。
function _metaMod(key, fallback) {
  return (typeof getModifier === 'function') ? getModifier(key) : fallback;
}

// 共有 URL（doGameOver で非同期生成し shareToX で使う）
let _pendingShareId = null;

// セッショントークン（beginGame() で取得し _createShare() で使う）
let _sessionToken = null;

// チュートリアルステージ番号（1始まり、非tutorialはnull）
function _tutStageNum() {
  if (curMode()?.type !== 'tutorial') return null;
  const idx = CFG.STAGES.findIndex(s => s.id === currentStageId);
  return idx >= 0 ? idx + 1 : null;
}

// replay / anti-cheat 用メタデータ
let _gameStartTime     = 0; // beginGame() でセット
let _dropCount         = 0; // 天体を落とすたびにカウント
let _clusterVanishCount = 0; // 銀河団同士の消滅回数（ゲーム内）
// speedrun: 銀河団作成までのタイム計測
let _speedrunCleared   = false;
let _speedrunClearMs   = 0;
// ポーズ (メニュー開放) 中の時間を経過時間から除外する
let _pausedTotalMs     = 0;   // 累計のポーズ時間 (ms)
let _pauseStartedAt    = 0;   // 現在ポーズ中ならその開始時刻、ポーズ外なら 0
function _onPauseStart() {
  if (_pauseStartedAt > 0 || waiting || dead) return;
  _pauseStartedAt = Date.now();
}
function _onPauseEnd() {
  if (_pauseStartedAt === 0) return;
  const dur = Date.now() - _pauseStartedAt;
  _pausedTotalMs += dur;
  // time モード: 制限時間を延長 (ポーズ時間ぶん終了時刻を後ろ倒し)
  if (_timeLimitMs > 0 && _gameEndAt > 0) _gameEndAt += dur;
  _pauseStartedAt = 0;
}
// 実プレイ経過 ms (ポーズ時間を除外)
function _getPlayElapsedMs() {
  let elapsed = Date.now() - _gameStartTime - _pausedTotalMs;
  if (_pauseStartedAt > 0) elapsed -= (Date.now() - _pauseStartedAt);
  return Math.max(0, elapsed);
}
// mm:ss.SSS 形式に変換 (例: 95623 → "1:35.623")
function _formatSpeedrunTime(ms) {
  if (!ms || ms < 0) return '--:--.---';
  const total = Math.floor(ms);
  const min = Math.floor(total / 60000);
  const sec = Math.floor((total % 60000) / 1000);
  const mil = total % 1000;
  return `${min}:${String(sec).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
}
let _mergeCount        = 0; // このゲームでの合成回数（doGameOver で累計に加算）
let _bodyMergeCount    = []; // このゲームでの天体種別合成回数（インデックス=bi）
let _savedBodyMerges   = []; // ゲーム開始時に localStorage から読み込んだ累計
let _maxChainThisGame  = 0;  // このゲームの最高連鎖数
let _skillUsedTypes    = new Set(); // このゲームで使ったスキル種別（チュートリアル目標判定用）
let _skillUsedCounts   = {};        // { bomb:0, upgrade:0, delete:0 } — 各スキルの使用回数
let _maxTierThisGame   = 0;  // このゲームで生成した最高 Tier（天体インデックス。requireTier 判定用）
let _timeLimitMs       = 0;  // 制限時間 (ms)。0 = 無制限（time/tutorial で設定）
let _gameEndAt         = 0;  // 制限時間切れの時刻 (Date.now() 基準)。_timeLimitMs>0 のとき有効
let _chainEventCount   = 0;  // このゲームで発生した連鎖回数（finalCount>=2の解決回数）
let _lastDropHadChain  = false; // 前のドロップで連鎖が発生したか
let _consecutiveChainDrops = 0; // 連続連鎖ドロップ数
let _chainCountsByLevel = []; // このゲームでの各連鎖レベル(5〜15)達成回数
let _savedChainCounts   = []; // ゲーム開始時に localStorage から読み込んだ累計
let _skillJustUsed           = false; // スキルが適用されてから次のドロップ/連鎖解決前か
let _skillChainCountsByLevel = []; // このゲームでのスキル経由各連鎖レベル(5〜10)達成回数
let _savedSkillChainCounts   = []; // ゲーム開始時に localStorage から読み込んだ累計

// ゲームオーバーアニメーション
// ・天体をランダム順に消去し、最後の天体が消えた後にオーバーレイを表示する
// ・消去間隔 = GO_ANIM_MS ÷ 天体数 → 天体数に関わらず合計所要時間がほぼ一定
const GO_ANIM_MS   = 2500; // 全天体消去にかける合計時間 (ms)
const POP_DUR_MS   = 320;  // 1個あたりのポップアニメーション時間 (ms)
const GO_FLASH_MS  = 900;  // アウト天体の点滅強調時間 (ms) — この後に消去アニメが始まる
let _goPopEffects  = [];   // { x, y, bi, startTime }
let _goFlashIds    = new Set(); // 点滅強調するアウト天体のID
let _goFlashStart  = 0;         // 点滅開始時刻 (Date.now())
let _autoReturnTid = null;      // チュートリアルクリア後の自動ホーム返却タイマーID
let _pendingReward = null;      // クリア時に取得した報酬 {stardust}。init() でパーティクルに使用

// チュートリアルクリア時のオーバーレイボタンを切り替える。
// 「ホームに戻る」＋「次へ進む」を表示し、通常の「もう一度」等を隠す。
function _startAutoReturn() {
  _showTutorialClearButtons(_endReason === 'clear' && curMode().type === 'tutorial');
}
function _clearAutoReturn() {
  if (_autoReturnTid !== null) { clearTimeout(_autoReturnTid); _autoReturnTid = null; }
}
function _showTutorialClearButtons(isTutClear) {
  const nextBtn  = document.getElementById('next-stage-btn');
  const shareB   = document.getElementById('share-btn');
  if (isTutClear) {
    // チュートリアルクリア: retry=ホームに戻る、next=次へ進む、他を隠す
    if (retryBtn)  { retryBtn.textContent = T('backToHome'); retryBtn.style.display = ''; }
    if (nextBtn) {
      // 最終ステージクリアなら「次へ進む」を隠す
      const _stages  = CFG.STAGES;
      const _isLast  = _stages.length && currentStageId === _stages[_stages.length - 1].id;
      nextBtn.textContent  = T('nextStage');
      nextBtn.style.display = _isLast ? 'none' : '';
    }
    if (shareB) shareB.classList.add('is-hidden');
  } else {
    // 通常終了: タイムアタック時間切れはホームに戻る、それ以外はもう一度
    const _btnLabel = (_endReason === 'timeup') ? T('backToHome') : T('retry');
    if (retryBtn)  { retryBtn.textContent = _btnLabel; retryBtn.style.display = ''; }
    if (nextBtn)   nextBtn.style.display  = 'none';
    // shareBtn の復元は _restoreShareButton() に任せる（呼び出し済み）
  }
  // ランキング/実績ボタンは終了画面から廃止 (設定メニュー＋ホームナビからアクセス)
}

// ============================================================
// UTIL
// ============================================================
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ============================================================
// INIT — ゲーム全体の初期化（「リセット」時も呼ばれる）
// ============================================================
function init() {
  _clearAutoReturn(); // チュートリアル自動返却タイマーが残っていればキャンセル
  // canvas バッファを DPR 倍に設定し、論理座標は CFG.W×CFG.H のままにする。
  // これにより Retina/高DPI ディスプレイで描画がくっきりする。
  // ※ canvas.width を再代入するとコンテキスト状態がリセットされるため、
  //   必ずその直後に ctx.scale(_dpr, _dpr) を呼ぶ。
  canvas.width  = CFG.W * _dpr;
  canvas.height = CFG.H * _dpr;
  ctx.scale(_dpr, _dpr);
  resize();

  score = 0; dangerCnt = 0; dead = false; paused = false; waiting = true;
  _endIsClear = false; // クリア表示フラグをリセット
  _endReason  = 'gameover';
  // チュートリアル完了後に currentModeId が 'tutorial' のままなら time/保存モードへ。
  if (isStageTutorialDone() && curMode().type === 'tutorial') {
    const saved = localStorage.getItem(STORAGE_KEYS.LAST_MODE);
    // 解放されていないモードが保存されていた場合は DEFAULT_MODE にフォールバック
    const savedDef = CFG.MODES.find(m => m.id === saved && m.type !== 'tutorial');
    currentModeId = (savedDef && isUnlocked(savedDef)) ? saved : CFG.DEFAULT_MODE;
  }
  // tutorial モードなら未クリアの先頭ステージを選択（クリア状況に応じて進行）
  if (curMode().type === 'tutorial') currentStageId = firstUnclearedStageId();
  _resetStats();
  // ゲームオーバー・設定オーバーレイを閉じる（スタート画面は表示しない）
  hide(overlay);         // ゲームオーバーオーバーレイ
  document.body.classList.remove('game-ended'); // スキルバー/フィードバックの状態リセット
  if (_overlayTitleEl) _overlayTitleEl.textContent = T('gameOver'); // タイトルを既定へ戻す
  _showTutorialClearButtons(false); // チュートリアルクリア用ボタンを通常状態へ戻す
  _closeModeSelectSheet(); // モード選択シートが残っていれば閉じる
  document.getElementById('share-note')?.classList.remove('show');
  const _rankPctEl = document.getElementById('rank-pct-el');
  if (_rankPctEl) { hide(_rankPctEl); _rankPctEl.textContent = ''; }
  shareBtn.classList.remove('is-hidden'); // stage モードで隠した場合に備え戻す
  _restoreShareButton();
  hide(settingsOverlay); // 設定オーバーレイ
  startScreen.classList.remove('hidden');    // スタート画面を表示（#start-screen の .hidden を外す）
  showResourceBar(); // リソースバーをホーム画面で表示
  // ホーム下部バーを表示し、チュートリアル進捗に応じてボタンを解禁、プレイタブに戻す
  document.getElementById('home-nav')?.classList.add('show');
  updateHomeNav();
  showHomeTab('play');
  // デスクトップ: 3パネル常時表示のため両パネルのtickを起動。モバイル: 1回描画のみ。
  if (typeof ensureDesktopTicks === 'function') ensureDesktopTicks();
  else {
    if (typeof renderCosmos   === 'function') renderCosmos();
    if (typeof renderResearch === 'function') renderResearch();
  }
  updateModeToggle();    // プレイパネルのモード/ステージ表記を更新
  updateStageObjective(); // プレイ中バナーを隠す（waiting=true のため）
  dropX = CFG.W / 2; canDrop = true;
  bmap = new Map(); mq = []; glowMap = new Map();
  if (dropTimer) clearTimeout(dropTimer);

  curBi = rnd(); nxtBi = rnd();
  _previewLookahead = []; _maintainPreviewLookahead();

  _buildPhysicsWorld();
  updateHUD();

  // やる気メッセージ: 終了画面側を止め、ホーム側を開始
  if (typeof stopMotivationCycle === 'function') stopMotivationCycle();
  const _homeMotivEl = document.getElementById('home-motivation');
  if (_homeMotivEl && typeof startMotivationCycle === 'function') startMotivationCycle(_homeMotivEl);

  _updateIntroVideo(); // 紹介動画の表示/非表示を更新
}

// 紹介動画パネルの表示制御。チュートリアル完了 or × で閉じた場合は非表示。
// _introClosed はセッション限定（リロードでリセット）→ 未完了なら再訪問で再表示。
let _introClosed = false;
function _updateIntroVideo() {
  const ss = document.getElementById('start-screen');
  if (!ss) return;
  const hide = (typeof isStageTutorialDone === 'function' && isStageTutorialDone()) || _introClosed;
  ss.classList.toggle('intro-hidden', hide);
  const vid = document.getElementById('intro-video');
  if (vid) {
    if (hide) { try { vid.pause(); } catch (_) {} }
    else      { const p = vid.play && vid.play(); if (p && p.catch) p.catch(() => {}); }
  }
}
// × ボタン: このセッション中は非表示
const _introCloseBtn = document.getElementById('intro-video-close');
if (_introCloseBtn) on(_introCloseBtn, () => { _introClosed = true; _updateIntroVideo(); });

// 物理エンジン・壁・衝突イベントを再構築する（init からのみ呼ばれる）。
// bmap などの状態リセット後に呼ぶこと。
function _buildPhysicsWorld() {
  if (eng) { Matter.Events.off(eng); Matter.Engine.clear(eng); }
  // R3: 研究効果 fallSpeedMult (負値で重力減 = 落下遅延)
  const gravMod = (typeof getModifier === 'function') ? getModifier('fallSpeedMult') : 1;
  eng   = Matter.Engine.create({
    enableSleeping: true,
    gravity: { y: CFG.PHYS.GRAVITY * gravMod },
    positionIterations: CFG.PHYS.POS_ITER,
    velocityIterations: CFG.PHYS.VEL_ITER,
  });
  world = eng.world;

  const { L, R, T, B, W: wt, GL, GR } = CFG.BOX;
  const wo = {
    isStatic: true, label: 'wall',
    friction: CFG.PHYS.FRIC, frictionStatic: CFG.PHYS.FRIC_S,
  };
  Matter.Composite.add(world, [
    // 底面
    Matter.Bodies.rectangle((L+R)/2,  B + wt/2,  R-L+wt*2, wt,     wo),
    // 左壁
    Matter.Bodies.rectangle(L - wt/2, (T+B)/2,   wt,       B-T+wt, wo),
    // 右壁
    Matter.Bodies.rectangle(R + wt/2, (T+B)/2,   wt,       B-T+wt, wo),
    // 左ガイド壁（ドロップゾーン・BOX.L より広め）
    Matter.Bodies.rectangle(GL - wt/2, T/2,       wt,       T,      wo),
    // 右ガイド壁（ドロップゾーン・BOX.R より広め）
    Matter.Bodies.rectangle(GR + wt/2, T/2,       wt,       T,      wo),
  ]);

  Matter.Events.on(eng, 'collisionStart',  onColl);           // 接触開始
  Matter.Events.on(eng, 'collisionActive', onColl);           // 接触継続中（クールダウン解除後の再判定）
  Matter.Events.on(eng, 'afterUpdate',     checkCustomSleep); // 振動検出による強制スリープ
  Matter.Events.on(eng, 'afterUpdate',     scanNearby);       // 近距離ペアを補完スキャン
  Matter.Events.on(eng, 'afterUpdate',     flushMerges);      // スキャン結果を処理（登録順で後に実行）
  Matter.Events.on(eng, 'afterUpdate',     _applyGravityWell);// R3: 中央寄せ力 (gravityWell)
  Matter.Events.on(eng, 'afterUpdate',     _checkEndlessAutoSave); // エンドレス自動セーブ（静止時）
}

// R3 gravityWell: 全ボディに対し盤面中央寄せの軽い力を加える
const _BOX_CX = (CFG.BOX.L + CFG.BOX.R) / 2;
function _applyGravityWell() {
  if (dead) return;
  const strength = (typeof getModifier === 'function') ? getModifier('gravityWell') : 0;
  if (strength <= 0) return;
  for (const d of bmap.values()) {
    const b = d.body;
    const dx = _BOX_CX - b.position.x;
    // 重力スケール: 質量×係数。X 方向のみ（Y はゲーム本来の重力に任せる）
    const fx = dx * 0.000020 * strength * b.mass;
    Matter.Body.applyForce(b, b.position, { x: fx, y: 0 });
  }
}

// スコア・各種カウンタ・スキル・連鎖・チュートリアル状態をリセットする
// （init からのみ呼ばれる）。コア状態フラグ（dead/paused/waiting/score）は
// 呼び出し側 init() に残してある。
function _resetStats() {
  _pendingShareId = null;
  _goPopEffects = [];
  _goFlashIds.clear();
  _goFlashStart = 0;
  _dropCount = 0;
  _clusterVanishCount = 0;
  _mergeCount = 0;
  _bodyMergeCount = [];
  _savedBodyMerges = JSON.parse(localStorage.getItem(STORAGE_KEYS.BODY_MERGES) || '[]');
  _maxChainThisGame = 0;
  _skillUsedTypes  = new Set();
  _skillUsedCounts = { bomb: 0, upgrade: 0, delete: 0 };
  _maxTierThisGame = 0;
  _timeLimitMs = 0;
  _gameEndAt = 0;
  _chainEventCount = 0;
  _lastDropHadChain = false;
  _consecutiveChainDrops = 0;
  _chainCountsByLevel = [];
  _savedChainCounts = JSON.parse(localStorage.getItem(STORAGE_KEYS.CHAIN_COUNTS) || '[]');
  _skillJustUsed = false;
  _skillChainCountsByLevel = [];
  _savedSkillChainCounts = JSON.parse(localStorage.getItem(STORAGE_KEYS.SKILL_CHAIN_COUNTS) || '[]');
  chainCount = 0;
  clearTimeout(chainTimer);       chainTimer = null;
  clearTimeout(chainResolveTimer); chainResolveTimer = null;
  chainEl.classList.remove('show', 'chain-final');
  _chainBaseScore = 0; _isSkillChain = false;
  _skillChainBonus = false;
  clearTimeout(_skillChainBonusTimer); _skillChainBonusTimer = null;
  const _csaElR = document.getElementById('chain-score-anim');
  if (_csaElR) _csaElR.classList.remove('csa-show');
  // スキル状態リセット（所持数は config の初期値＋研究ボーナス）
  skillCharges = { ...CFG.SKILL_INIT_CHARGES };
  const _skillBonus = _metaMod('skillCharge', 0);
  if (_skillBonus > 0) {
    for (const _k of Object.keys(skillCharges)) {
      if (Number.isFinite(skillCharges[_k])) skillCharges[_k] += _skillBonus;
    }
  }
  activeSkill = null; bombMode = false;
  if (bombBody) { Matter.Composite.remove(world, bombBody, true); bombBody = null; }
  bombHit = false; clearTimeout(bombFuseTimer); bombFuseTimer = null; bombExplosion = null;
  skillSelectMode = false; skillSelectedId = null;
  hide(skillConfirmEl);
  chainRewardPending = false;
  document.getElementById('chain-reward').classList.remove('show');
  clearTimeout(choiceAutoTimer); choiceAutoTimer = null;
  clearTimeout(choicePeekTimer); choicePeekTimer = null;
  rltReset();
  rouletteQueue.length = 0;
  pendingChoiceRewards = 0;
  updateRewardQueueInfo();
  updateSkillBarRewardState();
  // チュートリアル・強制使用・リマインダーをリセット
  tutorialActive = false; tutorialTargetId = null; _forcedSkillActive = false;
  hideTutorialPointer();
  _session5ChainCount = 0; _sessionEverClaimed = false; _sessionEverUsedSkill = false;
  updateSkillButtons();
  updateReminderHighlight();
}

// 出現する天体をランダム選択（0 〜 MAX_SPAWN の範囲）
function rnd() {
  // R3 highTierSpawnMult: 高 Tier ほど出やすくなる重み付け
  const maxBi = CFG.RULES.MAX_SPAWN;
  const bonus = (typeof getModifier === 'function') ? (getModifier('highTierSpawnMult') - 1) : 0;
  if (bonus <= 0) return Math.floor(Math.random() * (maxBi + 1));
  // weight[i] = 1 + bonus * (i / maxBi)  → 低 Tier=1、最高 Tier=1+bonus
  const weights = [];
  let total = 0;
  for (let i = 0; i <= maxBi; i++) {
    const w = 1 + bonus * (i / maxBi);
    weights.push(w);
    total += w;
  }
  let r = Math.random() * total;
  for (let i = 0; i <= maxBi; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return maxBi;
}

// ============================================================
// SPAWN — 「天体」を物理ワールドに生成
// ============================================================
function spawn(x, y, bi) {
  const def = CFG.BODIES[bi];
  const b = Matter.Bodies.circle(x, y, def.r, {
    label: 'celestial',
    friction:       CFG.PHYS.FRIC,
    frictionAir:    CFG.PHYS.FRIC_AIR,
    frictionStatic: CFG.PHYS.FRIC_S,
    restitution:    CFG.PHYS.REST,
    slop:           CFG.PHYS.SLOP,
  });
  bmap.set(b.id, { bi, at: Date.now(), body: b });
  Matter.Composite.add(world, b);
  return b;
}

// ============================================================
// DROP — プレイヤーが「天体」（または爆弾）を落とす
// ============================================================
function drop() {
  if (!canDrop || dead || waiting || chainTimer !== null || chainResolveTimer !== null || rouletteActive) return;
  if (skillSelectMode) return;
  _noteInput(); // 案内ポインターのアイドル判定をリセット
  // chainRewardPending 中（5連鎖報酬パネル表示中）もドロップ可能にする
  canDrop = false;
  _dropCount++; // 投下カウント（replay / anti-cheat 用）

  // 前のターンに連鎖があったか確認して連続連鎖を更新（初回ドロップは対象外）
  if (_dropCount > 1) {
    if (_lastDropHadChain) {
      _consecutiveChainDrops++;
      achCheckConsecutiveChain(_consecutiveChainDrops);
    } else {
      _consecutiveChainDrops = 0;
    }
  }
  _lastDropHadChain = false;
  _skillJustUsed = false; // ドロップ境界を超えたらスキル連鎖は無効
  _skillChainBonus = false; // 手動ドロップ後はスキル連鎖ウィンドウを閉じる
  clearTimeout(_skillChainBonusTimer); _skillChainBonusTimer = null;

  if (bombMode) {
    // 爆弾を投下（curBi は変えない）
    const r = CFG.BOMB.R;
    const x = clamp(dropX, CFG.BOX.L + r + 1, CFG.BOX.R - r - 1);
    bombBody = spawnBomb(x, CFG.DROP_Y);
    bombMode = false;
    activeSkill = null;
    if (skillCharges.bomb !== Infinity) skillCharges.bomb--;
    noteSkillUsed('bomb'); // チュートリアル目標判定用
    updateSkillButtons();
    if (_forcedSkillActive) onForcedSkillUsed(); // 強制爆弾は投下で完了
  } else {
    const def = CFG.BODIES[curBi];
    const x = clamp(dropX, CFG.BOX.L + def.r + 1, CFG.BOX.R - def.r - 1);
    spawn(x, CFG.DROP_Y, curBi);
    _endlessDirty = true; // 盤面変化 → 静止時に自動セーブ
    _checkSimultaneous();
    // R3 previewLength: 先読みキューがあれば優先消費
    curBi = nxtBi;
    nxtBi = _previewLookahead.length > 0 ? _previewLookahead.shift() : rnd();
    _maintainPreviewLookahead();
    updateHUD();
  }

  dropTimer = setTimeout(() => { canDrop = true; }, CFG.RULES.COOLDOWN);
}

// ============================================================
// 合成生成位置の計算（速度の逆数による重み付き補間）
//
// 「合成」時に新しい天体をどこに生成するかを決める。
// 重み w = 1 / (speed + EPS)^BIAS で連続的に決定するため
// 「静止 vs 高速」「両静止」「両移動」を if 分岐なしで統一処理できる。
//
//   両方静止       → 重みが等しい → 中間点に生成
//   一方静止・一方高速 → 静止側の重みが圧倒的 → 静止側寄りに生成
//   両方移動       → 遅い方に寄る
//
// BIAS・EPS は CFG.RULES で調整可能。
// ============================================================
function mergeSpawnPos(bA, bB) {
  const { MERGE_POS_BIAS: bias, MERGE_POS_EPS: eps } = CFG.RULES;
  const velA = Math.hypot(bA.velocity.x, bA.velocity.y);
  const velB = Math.hypot(bB.velocity.x, bB.velocity.y);
  // 遅いほど重みが大きくなる（eps で完全静止でも安定）
  const wA = 1 / Math.pow(velA + eps, bias);
  const wB = 1 / Math.pow(velB + eps, bias);
  const t  = wA / (wA + wB); // A の寄与率（0=B 側, 1=A 側）
  return {
    x: bA.position.x * t + bB.position.x * (1 - t),
    y: bA.position.y * t + bB.position.y * (1 - t),
  };
}

// ============================================================
// COLLISION → MERGE QUEUE
// 「合成」トリガー: 同種天体が接触したら mq（合成待ちキュー）に追加
// ============================================================
function onColl(evt) {
  const now = Date.now();

  // 爆弾の衝突検知（bombBody が存在し未点火なら導火線を開始）
  if (bombBody && !bombHit) {
    for (const { bodyA, bodyB } of evt.pairs) {
      if (bodyA.id === bombBody.id || bodyB.id === bombBody.id) {
        startBombFuse(); break;
      }
    }
  }

  for (const { bodyA: bA, bodyB: bB } of evt.pairs) {
    const dA = bmap.get(bA.id), dB = bmap.get(bB.id);
    if (!dA || !dB || dA.bi !== dB.bi) continue;

    // 合成直後の天体は猶予時間が切れるまで再合成しない
    if (now - dA.at < CFG.RULES.MERGE_GRACE_MS) continue;
    if (now - dB.at < CFG.RULES.MERGE_GRACE_MS) continue;
    const key = bA.id < bB.id ? `${bA.id}-${bB.id}` : `${bB.id}-${bA.id}`;
    if (mq.some(m => m.key === key)) continue;

    const vanish = dA.bi >= CFG.BODIES.length - 1; // 銀河団同士は消滅

    const { x, y } = mergeSpawnPos(bA, bB);
    mq.push({ key, bA, bB, bi: dA.bi, vanish, x, y });
  }
}

// ============================================================
// 連鎖カウント処理
// 合成が起きるたびに呼ぶ。CHAIN_WINDOW_MS 以内に次の合成が来れば連鎖が続く。
// 2連鎖以上になったら #chain-display に「N連鎖！」を表示する。
// ============================================================
function triggerChain() {
  // chainTimer（連鎖ウィンドウ）だけをキャンセル。chainResolveTimer は独立。
  clearTimeout(chainTimer);
  chainTimer = null;

  // スキル連鎖判定: スキル使用後800ms以内の連鎖開始（chainCount=0時）
  // スキルを「1連鎖目」として先行カウントし、この合成を2連鎖目にする
  if (_skillChainBonus && chainCount === 0) {
    _isSkillChain = true;
    chainCount = 1;
    clearTimeout(_skillChainBonusTimer);
    _skillChainBonus = false;
    _skillChainBonusTimer = null;
  }

  chainCount++;
  if (chainCount > _maxChainThisGame) _maxChainThisGame = chainCount;
  playMergeSound(chainCount);

  // 2連鎖以上: 連鎖数と現在の倍率を表示
  if (chainCount >= 2) {
    const _cm = _chainMultiplier(chainCount);
    const _multStr = _isSkillChain
      ? `×${_cm.toFixed(1)} ×2`
      : `×${(_cm).toFixed(1)}`;
    chainEl.innerHTML = `${T('chain')(chainCount)}<span class="chain-mult${_isSkillChain ? ' chain-skill' : ''}">${_multStr}</span>`;
    chainEl.classList.remove('show', 'chain-final');
    void chainEl.offsetWidth;
    chainEl.classList.add('show');
  }

  // 連鎖ウィンドウ: 800ms 以内に次の合成が来なければ連鎖終了
  chainTimer = setTimeout(() => {
    const finalCount = chainCount;
    chainCount = 0;
    chainTimer = null;

    // 1連鎖: バッファスコアをそのまま加算（倍率なし・演出なし）
    if (finalCount <= 1) {
      score += _chainBaseScore;
      _chainBaseScore = 0;
      _isSkillChain = false;
      updateHUD();
      return;
    }

    _chainEventCount++;
    _lastDropHadChain = true;
    achCheckTotalChains(
      parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_CHAINS) || '0', 10) + _chainEventCount
    );
    if (finalCount >= 5) {
      for (let _lvl = 5; _lvl <= Math.min(finalCount, 15); _lvl++) {
        _chainCountsByLevel[_lvl] = (_chainCountsByLevel[_lvl] || 0) + 1;
        achCheckChainByLevel(_lvl, (_savedChainCounts[_lvl] || 0) + _chainCountsByLevel[_lvl]);
      }
    }
    if (_skillJustUsed) {
      achCheckSkillChain(finalCount);
      if (finalCount >= 5) {
        for (let _lvl = 5; _lvl <= Math.min(finalCount, 10); _lvl++) {
          _skillChainCountsByLevel[_lvl] = (_skillChainCountsByLevel[_lvl] || 0) + 1;
          achCheckSkillChainByLevel(_lvl, (_savedSkillChainCounts[_lvl] || 0) + _skillChainCountsByLevel[_lvl]);
        }
      }
      _skillJustUsed = false;
    }

    // スコア確定（フィボナッチ倍率 × スキル連鎖2倍）
    const baseSc    = _chainBaseScore;
    const isSkill   = _isSkillChain;
    const finalMult = _chainMultiplier(finalCount) * (isSkill ? 2 : 1);
    score += Math.floor(baseSc * finalMult);
    _chainBaseScore = 0;
    _isSkillChain   = false;
    updateHUD();
    checkGoal();

    // スコア倍率演出（ベース×各ステップ高速再現）
    _playChainScoreAnim(baseSc, finalCount, isSkill);

    // 連鎖終了表示（「N連鎖！ ×M.M」）
    const _fm = _chainMultiplier(finalCount);
    const _fStr = isSkill ? `×${_fm.toFixed(1)} ×2` : `×${_fm.toFixed(1)}`;
    chainEl.classList.remove('show', 'chain-final');
    void chainEl.offsetWidth;
    chainEl.innerHTML = `${T('chain')(finalCount)}<span class="chain-mult${isSkill ? ' chain-skill' : ''}">${_fStr}</span>`;
    chainEl.classList.add('chain-final');

    chainResolveTimer = setTimeout(() => {
      chainResolveTimer = null;
      chainEl.classList.remove('chain-final');
      if      (finalCount === 4) enqueueRoulette();
      else if (finalCount >= 5) enqueueChoice();
    }, 280);
  }, CFG.RULES.CHAIN_WINDOW_MS);
}

// フィールド上の天体を種別ごとに数えて同時存在系実績をチェック
function _checkSimultaneous() {
  const counts = new Array(CFG.BODIES.length).fill(0);
  for (const d of bmap.values()) counts[d.bi]++;
  for (let _bi = 0; _bi < counts.length; _bi++) {
    if (counts[_bi] > 0) achCheckSimultaneous(_bi, counts[_bi]);
  }
}

// mq を処理して実際に「合成」を実行する
function flushMerges() {
  if (!mq.length) return;
  const q = mq.splice(0);
  const done = new Set();
  let anyMerged = false;
  for (const m of q) {
    if (done.has(m.bA.id) || done.has(m.bB.id)) continue;
    if (!bmap.has(m.bA.id) || !bmap.has(m.bB.id)) continue;
    done.add(m.bA.id); done.add(m.bB.id);
    anyMerged = true;
    _mergeCount++;
    achCheckMergeCount(
      parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_MERGES) || '0', 10) + _mergeCount
    );
    if (m.bi >= 1 && m.bi <= 8) {
      _bodyMergeCount[m.bi] = (_bodyMergeCount[m.bi] || 0) + 1;
      achCheckBodyMerge(m.bi, (_savedBodyMerges[m.bi] || 0) + _bodyMergeCount[m.bi]);
    }

    bmap.delete(m.bA.id); bmap.delete(m.bB.id);
    Matter.Composite.remove(world, m.bA, true);
    Matter.Composite.remove(world, m.bB, true);

    if (m.vanish) {
      // 銀河団同士は消滅：ボーナススコアを連鎖バッファへ（研究スコア倍率を適用）
      _chainBaseScore += Math.round(CFG.BODIES[m.bi].s * 2 * _metaMod('scoreMult', 1));
      _clusterVanishCount++;
      triggerChain();
      updateHUD();
      continue;
    }

    const ni = m.bi + 1;
    if (ni > _maxTierThisGame) _maxTierThisGame = ni; // requireTier 判定用
    _chainBaseScore += Math.round(CFG.BODIES[ni].s * _metaMod('scoreMult', 1)); // 連鎖バッファへ
    // speedrun: 銀河団 (ni === CFG.BODIES.length - 1) 作成でクリア発火 (重複ガード付き)
    if (ni === CFG.BODIES.length - 1 && curMode()?.type === 'speedrun' && !_speedrunCleared) {
      _speedrunCleared = true;
      _speedrunClearMs = _getPlayElapsedMs();
      setTimeout(() => doSpeedrunClear(), 50);
    }
    // モード解放判定: 中性子星 (bi=8) → speedrun、銀河団 (bi=11) → time
    _checkModeUnlock(ni);

    // 同座標スポーン防止: 微小オフセットを加える
    const ox = (Math.random() - 0.5) * 0.5;
    const oy = (Math.random() - 0.5) * 0.5;
    const nb = spawn(m.x + ox, m.y + oy, ni);
    _endlessDirty = true; // 合成で盤面変化 → 静止時に自動セーブ

    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * CFG.RULES.MERGE_BURST;
    Matter.Body.setVelocity(nb, {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
    });

    // 「合成時に少し光る仕様」のエフェクト登録（段階が上がるほど長く光る）
    const duration = 300 + ni * 100; // ni=1→400ms … ni=11→1400ms
    glowMap.set(nb.id, { endTime: Date.now() + duration, duration });

    triggerChain();
    updateHUD();
  }
  // 合成で生じた空間に周囲の天体が落下できるよう sleep を解除する
  if (anyMerged) { wakeAllBodies(); _checkSimultaneous(); }
}

// ============================================================
// CUSTOM SLEEP — 振動検出による強制スリープ
//
// Matter.js のデフォルト sleep は瞬間速度を基準にするため、
// 微小振動（行ったり来たりで net 変位がほぼゼロ）の天体が sleep しない。
// SLEEP_INTERVAL sub-step ごとに net 変位を計算し、
// 閾値未満なら「振動中」とみなして強制スリープさせる。
// ゆっくり落下・移動している天体は net 変位が大きいため sleep しない。
// ============================================================
const SLEEP_INTERVAL  = 60;   // 判定間隔 (sub-step 数)。4 sub-step/frame × 60fps で約 250ms
const SLEEP_NET_DISP2 = 0.25; // net 変位の二乗閾値 (px²)。0.5px 未満かつ高周波振動ならスリープ
const SLEEP_GRACE_MS  = 800; // スポーン・wake 直後のこの時間は判定しない (ms)

function checkCustomSleep() {
  if (dead) return;
  const now = Date.now();
  for (const d of bmap.values()) {
    if (now - d.at < SLEEP_GRACE_MS) continue; // スポーン直後は除外
    if (d.body.isSleeping) continue;           // すでに sleep 中はスキップ

    if (!d._sc) {
      d._sc = { x: d.body.position.x, y: d.body.position.y, tick: 0 };
      continue;
    }
    if (++d._sc.tick < SLEEP_INTERVAL) continue;

    const dx = d.body.position.x - d._sc.x;
    const dy = d.body.position.y - d._sc.y;
    // 次の判定ウィンドウのために現在位置を記録してカウンタをリセット
    d._sc.x = d.body.position.x;
    d._sc.y = d.body.position.y;
    d._sc.tick = 0;

    if (dx * dx + dy * dy < SLEEP_NET_DISP2) {
      Matter.Sleeping.set(d.body, true);
    }
  }
}

// ============================================================
// PROXIMITY MERGE SCAN
// 物理エンジンの solver 誤差で collisionActive が発火しないケースを補完する。
// 同種ボディを全ペア走査し、中心間距離が (r×2 + margin) 以内なら mq に積む。
// ============================================================
function scanNearby() {
  if (dead) return;
  const entries = [...bmap.values()]; // スナップショット（flushMerges の変更と干渉しない）
  const now = Date.now();
  for (let i = 0; i < entries.length - 1; i++) {
    const dA = entries[i];
    if (now - dA.at < CFG.RULES.MERGE_GRACE_MS) continue;
    const bA = dA.body;
    const r  = CFG.BODIES[dA.bi].r; // 同種なので rA === rB
    // R3 mergeAssist: 合成判定距離を緩和 (getModifier で value 加算分だけ拡張)
    const assist = (typeof getModifier === 'function') ? (getModifier('mergeAssist') - 1) : 0;
    const threshold = r * 2 + r * CFG.RULES.MERGE_MARGIN * (1 + assist);
    const thresh2   = threshold * threshold; // sqrt 回避

    for (let j = i + 1; j < entries.length; j++) {
      const dB = entries[j];
      if (dA.bi !== dB.bi) continue;
      if (now - dB.at < CFG.RULES.MERGE_GRACE_MS) continue;

      const bB = dB.body;
      const dx = bA.position.x - bB.position.x;
      const dy = bA.position.y - bB.position.y;
      if (dx * dx + dy * dy > thresh2) continue;

      const key = bA.id < bB.id ? `${bA.id}-${bB.id}` : `${bB.id}-${bA.id}`;
      if (mq.some(m => m.key === key)) continue;

      const vanish = dA.bi >= CFG.BODIES.length - 1;
      const { x, y } = mergeSpawnPos(bA, bB);
      mq.push({ key, bA, bB, bi: dA.bi, vanish, x, y });
    }
  }
}

// ============================================================
// GAME OVER CHECK — 危険ラインより上に天体が積み上がった状態を検出
// ============================================================
function checkDanger() {
  if (dead) return;
  const now = Date.now();
  let hi = false;
  for (const d of bmap.values()) {
    if (now - d.at < CFG.RULES.GRACE_MS) continue;
    if (d.body.position.y < CFG.DANGER_Y) { hi = true; break; }
  }
  dangerCnt = hi ? dangerCnt + 1 : 0;
  if (dangerCnt >= CFG.RULES.DANGER_F) doGameOver();
}

// tutorial モードのクリア判定。ステージ目標を全て満たすと doStageClear。
// time/endless モードや終了済み(dead)では何もしない（time は時間切れで終了）。
function checkGoal() {
  if (dead) return;
  const m = curMode();
  if (!m || m.type !== 'tutorial') return;
  const st = curStage();
  if (st && isObjectiveMet(st)) doStageClear();
}

// 制限時間切れによる終了。time モードでは通常終了（スコア表示）、
// tutorial モードでは目標未達のまま時間切れ＝失敗（リトライ）。
function doTimeUp() {
  if (dead) return;
  _endReason = 'timeup';
  doGameOver();
}

// speedrun クリア: 銀河団作成時に呼ばれる。タイムをベストと比較・保存し、終了フローへ移行。
function doSpeedrunClear() {
  if (dead) return;
  _endIsClear = true;
  _endReason  = 'speedrun_clear';
  const ms = _speedrunClearMs;
  // ベスト更新 (ms が小さいほど良い)
  const prev = parseInt(localStorage.getItem(STORAGE_KEYS.BEST_SPEEDRUN_MS) || '0', 10);
  if (!prev || ms < prev) {
    localStorage.setItem(STORAGE_KEYS.BEST_SPEEDRUN_MS, String(ms));
  }
  // 終了フロー (オーバーレイ表示・ランキング送信は B/C フェーズで仕上げ)
  doGameOver();
}

// ステージクリア。クリア済みを記録し、終了フロー(doGameOver)を再利用して
// オーバーレイを表示する（_endReason='clear' でタイトルを「クリア」に出し分け）。
function doStageClear() {
  if (dead) return;
  _endIsClear = true;
  _endReason  = 'clear';
  markStageCleared(currentStageId);
  // 最終ステージクリアで多段チュートリアル完了 → 以降は time モードが既定に。
  const _stages = CFG.STAGES;
  const _isLast = _stages.length && currentStageId === _stages[_stages.length - 1].id;
  if (_isLast && !isStageTutorialDone()) {
    localStorage.setItem(STORAGE_KEYS.STAGE_TUTORIAL_DONE, '1');
  }
  // GA4: チュートリアルステージクリア
  const _stNum = _tutStageNum();
  logEvent('tutorial_stage_clear', {
    game_id:     'rollaxy',
    stage_id:    currentStageId,
    stage_num:   _stNum,
    score,
    elapsed_sec: Math.round((Date.now() - _gameStartTime) / 1000),
  });
  if (_isLast) {
    logEvent('tutorial_complete', {
      game_id:     'rollaxy',
      elapsed_sec: Math.round((Date.now() - _gameStartTime) / 1000),
      game_number: parseInt(localStorage.getItem(STORAGE_KEYS.GAME_COUNT) || '0', 10),
    });
  }
  doGameOver();
}

// 終了演出のタイミング (ms)。doGameOver 全モード共通の「停止→揺れ→スロー→通常」シーケンス。
const _END_FREEZE_MS  = 750;   // 完全停止 (0〜)
const _END_SHAKE_START_MS = 350; // 揺れ開始
const _END_SHAKE_DUR_MS = 380; // 揺れの長さ
const _END_SLOW_START_MS  = 750;  // スロー再開
const _END_SLOW_DUR_MS  = 750;   // スロー継続
const _END_TOTAL_DELAY_MS = _END_SLOW_START_MS + _END_SLOW_DUR_MS; // 通常速度に戻す時刻

function _runEndEffect() {
  if (eng && eng.timing) eng.timing.timeScale = 0;
  const wrap = document.getElementById('canvas-outer');
  if (wrap) {
    wrap.classList.remove('end-shake'); void wrap.offsetWidth; // animation reset
    setTimeout(() => wrap.classList.add('end-shake'), _END_SHAKE_START_MS);
    setTimeout(() => wrap.classList.remove('end-shake'), _END_SHAKE_START_MS + _END_SHAKE_DUR_MS);
  }
  setTimeout(() => { if (eng?.timing) eng.timing.timeScale = 0.3; }, _END_SLOW_START_MS);
  setTimeout(() => { if (eng?.timing) eng.timing.timeScale = 1; },   _END_TOTAL_DELAY_MS);
}

function doGameOver() {
  if (dead) return;
  dead = true;
  // エンドレスのゲームオーバーはセーブを破棄（一期一会。次は新規スタート）
  if (curMode()?.type === 'endless') _clearEndlessSave();
  // 停止 → 揺れ → スロー → 通常 の汎用演出を起動 (オーバーレイ表示はこの後遅延)
  _runEndEffect();
  if (dropTimer) clearTimeout(dropTimer);
  // 連鎖演出タイマーをすべて止める（ゲームオーバー後に報酬が発生しないよう）
  clearTimeout(chainTimer);       chainTimer = null;
  clearTimeout(chainResolveTimer); chainResolveTimer = null;
  _chainBaseScore = 0; _isSkillChain = false;
  const _csaElGO = document.getElementById('chain-score-anim');
  if (_csaElGO) _csaElGO.classList.remove('csa-show');
  rouletteQueue.length = 0; // キュー済みルーレットも破棄
  pendingChoiceRewards = 0; // 未受け取り報酬を破棄（スキルバーの「受け取る」ボタンを消す）
  tutorialActive = false; tutorialTargetId = null; _forcedSkillActive = false;
  hideTutorialPointer();
  rltReset(); // ルーレット表示中でもゲームオーバーで強制終了
  closeChoicePanel(); // updateSkillBarRewardState を内部で呼ぶ（pendingChoiceRewards=0 が先に必要）
  resetSkillState(); // スキル状態をクリア
  if (typeof updateStageObjective === 'function') updateStageObjective(); // 目標バナーを隠す
  // speedrun クリア時はスコアではなくタイム (mm:ss.SSS) を結果に表示
  if (_endReason === 'speedrun_clear' && _speedrunClearMs > 0) {
    finalEl.textContent = _formatSpeedrunTime(_speedrunClearMs);
  } else {
    finalEl.textContent = score;
  }
  // メタ報酬（全モード）。星屑・恒星エネルギーを付与し結果に表示。
  // typeof ガードで game-meta.js 未ロードでも安全。
  const _rwEl = document.getElementById('reward-el');
  if (typeof grantPlayReward === 'function') {
    // R3: 今回のプレイ中で達成した最高 Tier を渡す (highTierBonus 計算用)
    let _maxTier = 0;
    for (const d of bmap.values()) if (d.bi > _maxTier) _maxTier = d.bi;
    const _rw = grantPlayReward(score, curMode().type, _maxTier);
    if (_rwEl) _rwEl.textContent = `${T('rewardGained')}: 💫 ${_rw.stardust}`;
    // ゲームオーバーオーバーレイ表示後にリソースバーへパーティクルを飛ばす
    _pendingReward = { stardust: _rw.stardust };
  } else if (_rwEl) {
    _rwEl.textContent = '';
  }
  // オーバーレイのタイトルを終了理由で出し分け（既定は data-i18n="gameOver"）。
  if (_overlayTitleEl) {
    _overlayTitleEl.textContent =
      _endReason === 'clear'           ? T('stageClear') :
      _endReason === 'timeup'          ? T('timeUp') :
      _endReason === 'speedrun_clear'  ? T('speedrunClear') :
                                         T('gameOver');
  }
  // 自己ベスト更新（endless / time それぞれ独立して管理）
  const _mtype = curMode().type;
  const isHi = (_mtype === 'endless' && score > hiScore) || (_mtype === 'time' && score > hiScoreTime);
  toggleShow(newHiEl, isHi);
  if (isHi) {
    if (_mtype === 'endless') {
      hiScore = score;
      localStorage.setItem(STORAGE_KEYS.HI_SCORE, score);
      localStorage.removeItem(STORAGE_KEYS.LEGACY_HI);
      hiEl.textContent = `${T('best')}: ${hiScore}`;
    } else if (_mtype === 'time') {
      hiScoreTime = score;
      localStorage.setItem(STORAGE_KEYS.BEST_SCORE_TIME, score);
    }
  }
  // GA4 game_over イベント
  // _startGameOverAnim() が bmap を順次削除する前にここで計算する
  let _highestTier = 0;
  for (const d of bmap.values()) { if (d.bi > _highestTier) _highestTier = d.bi; }
  const _elapsedSec = Math.round((Date.now() - _gameStartTime) / 1000);
  // ── プレイ統計を localStorage に蓄積 ──
  try {
    const _gc = parseInt(localStorage.getItem(STORAGE_KEYS.GAME_COUNT) || '0', 10);
    localStorage.setItem(STORAGE_KEYS.TOTAL_SEC,
      String((parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SEC)   || '0', 10)) + _elapsedSec));
    localStorage.setItem(STORAGE_KEYS.TOTAL_SCORE,
      String((parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_SCORE) || '0', 10)) + score));
    localStorage.setItem(STORAGE_KEYS.TOTAL_DROPS,
      String((parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_DROPS) || '0', 10)) + _dropCount));
    localStorage.setItem(STORAGE_KEYS.TOTAL_MERGES,
      String((parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_MERGES) || '0', 10)) + _mergeCount));
    for (let _bi = 1; _bi <= 8; _bi++) {
      if (_bodyMergeCount[_bi]) _savedBodyMerges[_bi] = (_savedBodyMerges[_bi] || 0) + _bodyMergeCount[_bi];
    }
    localStorage.setItem(STORAGE_KEYS.BODY_MERGES, JSON.stringify(_savedBodyMerges));
    localStorage.setItem(STORAGE_KEYS.TOTAL_CHAINS,
      String((parseInt(localStorage.getItem(STORAGE_KEYS.TOTAL_CHAINS) || '0', 10)) + _chainEventCount));
    for (let _lvl = 5; _lvl <= 15; _lvl++) {
      if (_chainCountsByLevel[_lvl]) _savedChainCounts[_lvl] = (_savedChainCounts[_lvl] || 0) + _chainCountsByLevel[_lvl];
    }
    localStorage.setItem(STORAGE_KEYS.CHAIN_COUNTS, JSON.stringify(_savedChainCounts));
    for (let _lvl = 5; _lvl <= 10; _lvl++) {
      if (_skillChainCountsByLevel[_lvl]) _savedSkillChainCounts[_lvl] = (_savedSkillChainCounts[_lvl] || 0) + _skillChainCountsByLevel[_lvl];
    }
    localStorage.setItem(STORAGE_KEYS.SKILL_CHAIN_COUNTS, JSON.stringify(_savedSkillChainCounts));
    const _prevMaxTier = parseInt(localStorage.getItem(STORAGE_KEYS.MAX_TIER) || '0', 10);
    if (_highestTier > _prevMaxTier) localStorage.setItem(STORAGE_KEYS.MAX_TIER, String(_highestTier));
    if (_clusterVanishCount > 0) {
      localStorage.setItem(STORAGE_KEYS.CLUSTER_VANISH,
        String((parseInt(localStorage.getItem(STORAGE_KEYS.CLUSTER_VANISH) || '0', 10)) + _clusterVanishCount));
    }
    // 銀河団（tier 11）到達ゲームをカウント
    if (_highestTier >= 11) {
      localStorage.setItem(STORAGE_KEYS.CLUSTER_COUNT,
        String((parseInt(localStorage.getItem(STORAGE_KEYS.CLUSTER_COUNT) || '0', 10)) + 1));
    }
  } catch (_) {}
  logEvent('game_over', {
    game_id:            'rollaxy',
    mode:               currentModeId,
    stage:              curMode()?.type === 'tutorial' ? currentStageId : null,
    tutorial_stage_num: _tutStageNum(),
    cleared:            _endIsClear ? 1 : 0,
    score,
    highest_tier:       _highestTier,
    drop_count:         _dropCount,
    elapsed_sec:        _elapsedSec,
    is_new_best:        isHi ? 1 : 0,
    lang:               typeof currentLang !== 'undefined' ? currentLang : 'ja',
  });
  // ランキング送信対象:
  //   endless / time は常に、speedrun は「クリア(銀河団到達)」時のみ送信。
  //   speedrun の失敗(天体あふれ)・tutorial/stage は対象外。
  _pendingShareId = null;
  const _shareMode = curMode()?.type;
  const _submitRanking = _shareMode === 'endless'
    || _shareMode === 'time'
    || (_shareMode === 'speedrun' && _endReason === 'speedrun_clear');
  if (_submitRanking) {
    shareBtn.classList.remove('is-hidden');
    shareBtn.disabled = true;
    shareBtn.textContent = T('sharePreparing');
    shareBtn.classList.add('loading');
    _createShare();
  } else {
    shareBtn.classList.add('is-hidden');
  }
  // アウトした天体を特定して点滅強調 → GO_FLASH_MS 後に通常の消去アニメを開始
  _goFlashIds.clear();
  for (const [id, d] of bmap.entries()) {
    if (d.body.position.y < CFG.DANGER_Y) _goFlashIds.add(id);
  }
  _goFlashStart = Date.now();
  // 演出 (_END_TOTAL_DELAY_MS 分の停止→揺れ→スロー) の後にフラッシュ/ポップ/オーバーレイへ
  setTimeout(_startGameOverAnim,
    _END_TOTAL_DELAY_MS + (_goFlashIds.size > 0 ? GO_FLASH_MS : 0));
}

// 天体をランダム順にポップ消去し、終わったらゲームオーバーオーバーレイを表示する
function _startGameOverAnim() {
  _goFlashIds.clear(); // 点滅終了 → 消去アニメへ移行
  const ids = [...bmap.keys()];
  if (ids.length === 0) {
    show(overlay);
    document.body.classList.add('game-ended'); // スキルバー fade out / feedback fade in
    // 終了画面のやる気メッセージを開始
    const _ovMotivEl = document.getElementById('overlay-motivation');
    if (_ovMotivEl && typeof startMotivationCycle === 'function') startMotivationCycle(_ovMotivEl);
    showResourceBar();
    _fireOverlayParticles();
    _startAutoReturn();
    return;
  }
  // Fisher-Yates シャッフル
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const interval = GO_ANIM_MS / ids.length;
  ids.forEach((id, idx) => {
    setTimeout(() => {
      _popBody(id);
      if (idx === ids.length - 1) {
        // 最後の天体のポップアニメが終わる頃にオーバーレイを表示
        setTimeout(() => {
          show(overlay);
          document.body.classList.add('game-ended'); // スキルバー fade out / feedback fade in
    // 終了画面のやる気メッセージを開始
    const _ovMotivEl = document.getElementById('overlay-motivation');
    if (_ovMotivEl && typeof startMotivationCycle === 'function') startMotivationCycle(_ovMotivEl);
          showResourceBar();
          _fireOverlayParticles();
          _startAutoReturn();
        }, POP_DUR_MS + 80);
      }
    }, Math.round(idx * interval));
  });
}

// ゲームオーバーオーバーレイ表示直後にリソースバーへパーティクルを飛ばす
function _fireOverlayParticles() {
  if (_pendingReward && typeof flyRewardParticles === 'function') {
    const _pr = _pendingReward;
    _pendingReward = null;
    setTimeout(() => flyRewardParticles(_pr.stardust), 350);
  }
}

// 天体を物理世界から除去してポップエフェクトを登録する
function _popBody(id) {
  const d = bmap.get(id);
  if (!d) return;
  _goPopEffects.push({
    x: d.body.position.x,
    y: d.body.position.y,
    bi: d.bi,
    startTime: performance.now(),
  });
  bmap.delete(id);
  glowMap.delete(id);
  Matter.Composite.remove(world, d.body, true);
}

// ============================================================
// HUD — ヘッダーのスコアと「次の天体が表示されているところ」を更新
// ============================================================
function updateHUD() {
  const _m = curMode();
  if (_m && _m.type === 'tutorial' && curStage() && curStage().goalScore != null) {
    scoreEl.textContent = `${T('score')}: ${score} / ${curStage().goalScore}`; // tutorial: 目標スコア併記
  } else {
    scoreEl.textContent = `${T('score')}: ${score}`;
  }
  achCheckScore(score);
  // チュートリアルではスコアが進捗指標になるステージがあるため、HUDも同期更新
  if (_m && _m.type === 'tutorial') updateStageObjective();
  const _ni = bodyImages[nxtBi];
  let _previewHtml;
  if (_ni && _ni.complete && _ni.naturalWidth > 0) {
    _previewHtml = `<img src="${_ni.src}" style="height:1.3em;vertical-align:middle;border-radius:50%">`;
  } else {
    _previewHtml = CFG.BODIES[nxtBi].e;
  }
  // R3 previewLength: 先読み天体を後ろに小さく追加
  for (const bi of _previewLookahead) {
    const ei = bodyImages[bi];
    if (ei && ei.complete && ei.naturalWidth > 0) {
      _previewHtml += `<img src="${ei.src}" style="height:0.85em;vertical-align:middle;margin-left:2px;border-radius:50%;opacity:0.65">`;
    } else {
      _previewHtml += `<span style="font-size:0.75em;opacity:0.65;margin-left:2px">${CFG.BODIES[bi].e}</span>`;
    }
  }
  nextEmoEl.innerHTML = _previewHtml;
}

// 残り時間表示（time / 制限時間付き tutorial ステージのみ表示）。loop から毎フレーム呼ぶ。
function updateTimerHUD() {
  const el = document.getElementById('timer-el');
  if (!el) return;
  // speedrun モードはカウントアップで経過時間を表示
  if (curMode()?.type === 'speedrun' && !waiting) {
    el.style.display = '';
    const elapsed = (dead || _speedrunCleared) ? _speedrunClearMs : _getPlayElapsedMs();
    el.textContent = `⏱ ${_formatSpeedrunTime(elapsed)}`;
    el.classList.remove('timer-warn');
    return;
  }
  if (_timeLimitMs <= 0 || waiting) { el.style.display = 'none'; return; }
  el.style.display = '';
  const remain   = dead ? 0 : Math.max(0, _gameEndAt - Date.now());
  const totalSec = Math.ceil(remain / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  el.textContent = `⏱ ${mm}:${String(ss).padStart(2, '0')}`;
  el.classList.toggle('timer-warn', remain <= 10000); // 残り10秒で警告色
}

// チュートリアルHUD（ヘッダー左エリアをチュートリアル情報で上書き）。
// beginGame / noteSkillUsed / updateHUD / langchange / 終了時に呼ぶ。
function updateStageObjective() {
  const header  = document.getElementById('header');
  const tutHud  = document.getElementById('tut-hud');
  const m       = curMode();
  const isTut   = !waiting && !dead && m.type === 'tutorial' && !!curStage();

  // ヘッダーにクラスを付与 → score/hi を CSS で隠す
  if (header) header.classList.toggle('tutorial-mode', isTut);

  if (!tutHud) return;
  if (!isTut) { tutHud.style.display = 'none'; return; }

  const s     = curStage();
  const idx   = CFG.STAGES.findIndex(x => x.id === s.id);
  const total = CFG.STAGES.length;

  // ステージ番号
  const stepEl = document.getElementById('tut-hud-step');
  if (stepEl) stepEl.textContent = `${modeName(m)} ${idx + 1}/${total}`;

  // 目標説明
  const descEl = document.getElementById('tut-hud-desc');
  if (descEl) descEl.textContent = stageDesc(s);

  // 進捗（スキル使用系 or スコア系）
  const progEl = document.getElementById('tut-hud-progress');
  if (progEl) {
    let html = '';
    if (s.requireAllSkills) {
      html = Object.entries(s.requireAllSkills).map(([skill, need]) => {
        const done = Math.min(_skillUsedCounts[skill] || 0, need);
        const met  = done >= need;
        return `<span class="tut-prog-item${met ? ' tut-prog-met' : ''}">${_skillIcon(skill)} ${done}/${need}</span>`;
      }).join('');
    } else if (s.requireSkillCount) {
      const { skill, count } = s.requireSkillCount;
      const done = _skillUsedCounts[skill] || 0;
      const met  = done >= count;
      html = `<span class="tut-prog-item${met ? ' tut-prog-met' : ''}">${_skillIcon(skill)} ${done}/${count}</span>`;
    } else if (s.goalScore != null) {
      html = `<span class="tut-prog-item">${score} / ${s.goalScore}</span>`;
    }
    progEl.innerHTML = html;
  }

  tutHud.style.display = 'block';
}

// ユーザー操作を記録（案内ポインターのアイドル判定リセット）。
function _noteInput() {
  _idleLastInput = Date.now();
  if (_objPointerActive) _hideObjPointer();
}
function _hideObjPointer() {
  _objPointerActive = false;
  const ptr = document.getElementById('tutorial-pointer');
  if (!ptr) return;
  ptr.classList.remove('show', 'obj-pointer');
  ptr.style.position = ''; ptr.style.left = ''; ptr.style.top = '';
  ptr.style.transform = ''; ptr.style.zIndex = '';
}
// チュートリアル中、操作が一定時間止まり目標未達なら、目標に応じた案内ポインターを出す。
// requireSkill ステージ → 該当スキルボタンを指す。それ以外 → 投下ゾーンを指す。
// loop() から毎フレーム呼ぶ（自己ガードあり）。
function updateObjectivePointer() {
  const ptr = document.getElementById('tutorial-pointer');
  if (!ptr) return;
  const m = curMode();
  const st = (m.type === 'tutorial') ? curStage() : null;
  if (waiting || dead || paused || !st || isObjectiveMet(st)) { _hideObjPointer(); return; }
  // 古いオンボーディング（tutorialActive）が指ポインターを使う場合は競合させない
  if (tutorialActive) { _hideObjPointer(); return; }
  if (Date.now() - _idleLastInput < OBJ_POINTER_IDLE_MS) { _hideObjPointer(); return; }

  // requireAllSkills → 未達成の最初のスキルを指す
  let _skillTarget = st.requireSkill || null;
  if (!_skillTarget && st.requireSkillCount) _skillTarget = st.requireSkillCount.skill;
  if (!_skillTarget && st.requireAllSkills) {
    const _unmet = Object.entries(st.requireAllSkills).find(
      ([skill, count]) => (_skillUsedCounts[skill] || 0) < count
    );
    _skillTarget = _unmet ? _unmet[0] : null;
  }
  // requireAnySkill: スコア目標達成済みでスキル未使用 → 所持スキルを指す
  if (!_skillTarget && st.requireAnySkill && _skillUsedTypes.size < st.requireAnySkill) {
    if (!st.goalScore || score >= st.goalScore) {
      _skillTarget = ['bomb', 'upgrade', 'delete'].find(
        s => skillCharges && (skillCharges[s] || 0) > 0
      ) || 'bomb';
    }
  }
  let targetEl = null, text = '';
  if      (_skillTarget === 'bomb')    { targetEl = document.getElementById('skill-bomb');    text = T('skillHintBomb'); }
  else if (_skillTarget === 'upgrade') { targetEl = document.getElementById('skill-upgrade'); text = T('skillHintUpgrade'); }
  else if (_skillTarget === 'delete')  { targetEl = document.getElementById('skill-delete');  text = T('skillHintDelete'); }
  else                                 { text = T('tutDropHint'); } // スコア/合成/tier 系 → 投下を促す

  const tEl = document.getElementById('tut-text');
  if (tEl) tEl.textContent = text;
  ptr.style.position = 'fixed';
  ptr.style.zIndex = '50';
  ptr.style.transform = 'translate(-50%, -100%)';
  if (targetEl) {
    const r = targetEl.getBoundingClientRect();
    ptr.style.left = (r.left + r.width / 2) + 'px';
    ptr.style.top  = (r.top - 6) + 'px';
  } else {
    const r = canvas.getBoundingClientRect();
    ptr.style.left = (r.left + r.width / 2) + 'px';
    ptr.style.top  = (r.top + r.height * 0.16) + 'px';
  }
  if (!_objPointerActive) { _objPointerActive = true; ptr.classList.add('show', 'obj-pointer'); }
}

// ============================================================
// GAME LOOP
// dead   = true → 物理停止（ゲームオーバー）、描画は継続して #overlay の背後に見える
// paused = true → 物理停止（設定中）、描画は継続して #settings-overlay の背後に見える
// ============================================================
let lastT = 0;
function loop(t) {
  const dt = Math.min(t - lastT, 50); // 最大50msでキャップ（タブ非表示対策）
  lastT = t;
  if (!dead && !paused && !waiting) {
    const subDt = dt / CFG.PHYS.SUBSTEPS;
    for (let i = 0; i < CFG.PHYS.SUBSTEPS; i++) {
      Matter.Engine.update(eng, subDt);
    }
    // flushMerges は afterUpdate イベントで各サブステップ後に処理される
    checkDanger();
    checkGoal(); // tutorial モードのクリア判定（time/endless では何もしない）
    // 制限時間切れチェック（time / 一部 tutorial ステージ）
    if (_timeLimitMs > 0 && Date.now() >= _gameEndAt) doTimeUp();
  }
  updateTimerHUD();
  draw();
  if (tutorialActive) updateTutorialPointerEl();
  updateObjectivePointer(); // チュートリアル目標の案内ポインター（自己ガードあり）
  requestAnimationFrame(loop);
}

// ============================================================
// RESPONSIVE RESIZE（スマホ向け）
// canvas は論理サイズ 400×700px を固定し、CSS transform:scale で画面サイズに合わせる。
// これにより物理演算の座標系を変えずにスマホ・PC どちらでも正しく表示できる。
// ============================================================
const _headerEl = document.getElementById('header');

// ============================================================
// VIEWPORT HEIGHT SYNC
// visualViewport.height が最も正確（アドレスバー・ソフトキー込みの実視認領域）。
// CSS custom property --app-height に注入することで body { height: var(--app-height) }
// が常に実際の見える高さに追随する。100dvh / 100vh のフォールバックより優先される。
// ============================================================
function _setVhVar() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', h + 'px');
}

function resize() {
  // outer.style.height は前回 resize() が設定した値なのでリセットしてから
  // flex により決定される実際の利用可能高さを読み取る。
  // これにより body の --app-height が更新された後の正確なサイズが取得できる。
  outer.style.height = '';
  const ow = outer.clientWidth  || CFG.W;
  const oh = outer.clientHeight || CFG.H;
  const s  = Math.min(ow / CFG.W, oh / CFG.H);
  const ox = Math.floor((ow - CFG.W * s) / 2);
  _canvasScale = s; _canvasOffsetX = ox; // ポインター座標変換用
  canvas.style.width           = CFG.W + 'px';
  canvas.style.height          = CFG.H + 'px';
  canvas.style.transform       = `scale(${s})`;
  canvas.style.transformOrigin = 'top left';
  canvas.style.left            = ox + 'px';
  outer.style.height           = Math.ceil(CFG.H * s) + 'px';
  // body bar（天体の段階表示）直下にヘッダーを配置
  const _barH = Math.round(CFG.BAR_H * s);
  _headerEl.style.top = _barH + 'px';
  // 実績トーストを天体バーと同じ高さに
  const _toastEl = document.getElementById('ach-toast');
  if (_toastEl) _toastEl.style.height = _barH + 'px';
  // 再フィットした時点のビューポート寸法を記録（_onViewportResize の判定用）
  _lastFitW = window.innerWidth;
  _lastFitH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
}

// アドレスバー開閉は「幅そのまま・高さだけ」変化させて resize を連発する。
// --app-height は毎回更新（CSS レイアウトを正しく保つ）。
// canvas のスケール再計算は幅変化 or 高さ変化が閾値超のときだけ行い
// アドレスバー展開/収縮のガタつきを防ぐ。
let _lastFitW = 0, _lastFitH = 0;
function _onViewportResize() {
  _setVhVar(); // --app-height を常に最新化（CSS レイアウトへ即反映）
  const w = window.innerWidth;
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (w === _lastFitW && Math.abs(h - _lastFitH) <= CFG.RESIZE_IGNORE_DH) return;
  resize();
}

// ============================================================
// INPUT（マウス＆タッチ）
// スマホ向け:
//   - touchmove に passive:false → preventDefault() でスクロールを封じる
//   - touchend でも drop() を呼ぶ → iOS の 300ms click 遅延を回避
//   - toLogicalX で CSS transform による座標ズレを補正
// ============================================================
function toLogicalX(clientX) {
  const r = canvas.getBoundingClientRect();
  return (clientX - r.left) * (CFG.W / r.width);
}

canvas.addEventListener('mousemove', e => {
  if (debugMode) {
    if (debugDragging) debugPlace(toLogicalX(e.clientX), toLogicalY(e.clientY));
    return;
  }
  if (!skillSelectMode) dropX = toLogicalX(e.clientX);
});
canvas.addEventListener('mousedown', e => {
  if (!debugMode) return;
  e.preventDefault();
  if (e.button === 0) { debugDragging = true; debugPlace(toLogicalX(e.clientX), toLogicalY(e.clientY)); }
  if (e.button === 2) debugRemove(toLogicalX(e.clientX), toLogicalY(e.clientY));
});
canvas.addEventListener('mouseup',    () => { debugDragging = false; });
canvas.addEventListener('mouseleave', () => { debugDragging = false; });
canvas.addEventListener('contextmenu', e => { if (debugMode) e.preventDefault(); });
canvas.addEventListener('click', e => {
  if (debugMode) return; // デバッグモード中は通常のクリック操作をスキップ
  _tryUnlockAudio(); // 最初のクリックで音声を解除
  _noteInput();      // 案内ポインターのアイドル判定をリセット
  const lx = toLogicalX(e.clientX);
  if (skillSelectMode) { handleSelectTap(lx, toLogicalY(e.clientY)); return; }
  dropX = lx; drop();
});

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (!skillSelectMode) dropX = toLogicalX(e.touches[0].clientX);
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  _tryUnlockAudio(); // 最初のタップで音声を解除
  _noteInput();      // 案内ポインターのアイドル判定をリセット
  const lx = toLogicalX(e.changedTouches[0].clientX);
  const ly = toLogicalY(e.changedTouches[0].clientY);
  if (skillSelectMode) { handleSelectTap(lx, ly); return; }
  dropX = lx; drop();
}, { passive: false });

// retry_click はここで発火（init() 内部ではなく）
// → ページ初回ロード時の init() と区別するため
// 「もう一度」表示時はホームを経由せず即ゲーム再開、「ホームに戻る」表示時はホーム遷移のみ。
on(retryBtn, () => {
  _clearAutoReturn();
  playDecisionSound();
  const isRestart = retryBtn.textContent === T('retry');
  logEvent('retry_click', { game_id: 'rollaxy', mode: currentModeId, tutorial_stage_num: _tutStageNum(), previous_score: score });
  const _retryMode  = currentModeId;
  const _retryStage = currentStageId;
  init();
  if (isRestart) beginGame(_retryMode, _retryStage);
});

// ホームに戻る (プレーンテキストの控えめリンク) — 常にホーム画面へ遷移
const _overlayHomeBtn = document.getElementById('overlay-home-btn');
if (_overlayHomeBtn) {
  on(_overlayHomeBtn, () => {
    _clearAutoReturn();
    playBackSound();
    init();
  });
}

// モード解放ポップアップの閉じるボタン + 背景タップ
const _modeUnlockCloseBtn = document.getElementById('mode-unlock-close');
const _modeUnlockModal    = document.getElementById('mode-unlock-modal');
if (_modeUnlockCloseBtn) on(_modeUnlockCloseBtn, () => _closeModeUnlockPopup());
if (_modeUnlockModal) {
  _modeUnlockModal.addEventListener('click', (e) => {
    if (e.target === _modeUnlockModal) _closeModeUnlockPopup();
  });
}

// 「次へ進む」— チュートリアルクリア後、次のステージへ直接進む
const _nextStageBtn = document.getElementById('next-stage-btn');
if (_nextStageBtn) {
  on(_nextStageBtn, () => {
    playDecisionSound();
    // 現在のステージの次を探して選択
    const _idx  = CFG.STAGES.findIndex(s => s.id === currentStageId);
    const _next = CFG.STAGES[_idx + 1] ?? null;
    if (_next) {
      currentStageId = _next.id;
      init();
      beginGame('tutorial', _next.id);
    } else {
      init(); // 最終ステージ後はホームへ（ボタン自体は最終時に隠れるが念のため）
    }
  });
}

on(startBtn, () => {
  _tryUnlockAudio();
  playDecisionSound();
  if (curMode().type !== 'tutorial') {
    // チュートリアル完了後: モード選択シートを表示
    _openModeSelectSheet();
  } else {
    // チュートリアル中: そのまま開始
    beginGame();
  }
});

// ── ランキング (ホーム画面オーバーレイ) ──
// 旧 game-meta.js から再実装。/api/rollaxy/ranking を fetch して #rank-list-home に描画。
// 期間タブ: 'weekly'/'all'（本日廃止済）、モードタブ: endless/time/speedrun。
let _rankHomeMode   = 'endless';
let _rankHomePeriod = 'weekly';

// score → 表示文字列。speedrun は時間形式 (10_000_000 - ms 逆換算)。
function _rankHomeFormatScore(rawScore, mode) {
  if (mode === 'speedrun') {
    const ms = Math.max(0, 10_000_000 - (rawScore || 0));
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    const mil = ms % 1000;
    return `${min}:${String(sec).padStart(2,'0')}.${String(mil).padStart(3,'0')}`;
  }
  return Math.floor(rawScore || 0).toLocaleString();
}

// オーバーレイ表示中の定期再取得タイマー。
// 表示名変更が反映されるまで最大 (KVキャッシュ 60s + ポーリング 60s) ≒ 2分
let _rankHomeRefreshTimer = null;
function openRankingHome() {
  const el = document.getElementById('ranking-overlay');
  if (!el) return;
  el.classList.add('show');
  renderRankingHome();
  if (_rankHomeRefreshTimer) clearInterval(_rankHomeRefreshTimer);
  _rankHomeRefreshTimer = setInterval(renderRankingHome, 60_000); // 1 分ごと
}
function closeRankingHome() {
  const el = document.getElementById('ranking-overlay');
  if (el) el.classList.remove('show');
  if (_rankHomeRefreshTimer) { clearInterval(_rankHomeRefreshTimer); _rankHomeRefreshTimer = null; }
}

async function renderRankingHome() {
  const list = document.getElementById('rank-list-home');
  if (!list) return;
  // タブ active 表示の同期
  document.querySelectorAll('#rank-mode-tabs .rank-mode').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === _rankHomeMode);
  });
  document.querySelectorAll('#rank-period-tabs .rank-period').forEach(b => {
    b.classList.toggle('active', b.dataset.period === _rankHomePeriod);
  });
  list.innerHTML = `<div class="rank-status">${T('rankLoading') || '読込中…'}</div>`;
  const tz = -(new Date().getTimezoneOffset());
  try {
    const res = await fetch(`/api/rollaxy/ranking?period=${_rankHomePeriod}&mode=${_rankHomeMode}&limit=20&tz=${tz}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const entries = data.entries || [];
    if (entries.length === 0) {
      list.innerHTML = `<div class="rank-status">${T('rankEmpty') || '記録なし'}</div>`;
      return;
    }
    const scoreUnit = _rankHomeMode === 'speedrun' ? '' : (T('scoreUnit') || '点');
    const escHtml = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    let html = '';
    for (const e of entries) {
      const rankClass = e.rank === 1 ? 'top1' : e.rank === 2 ? 'top2' : e.rank === 3 ? 'top3' : '';
      const name = e.display_name ? escHtml(e.display_name) : '—';
      html += `<div class="rank-row">`
            + `<span class="rr-rank ${rankClass}">#${e.rank}</span>`
            + `<span class="rr-name">${name}</span>`
            + `<span class="rr-score">${_rankHomeFormatScore(e.score, _rankHomeMode)}${scoreUnit}</span>`
            + `</div>`;
    }
    list.innerHTML = html;
  } catch (_) {
    list.innerHTML = `<div class="rank-status error">${T('rankError') || '取得失敗'}</div>`;
  }
}

// タブ click 配線 (mode / period)
document.querySelectorAll('#rank-mode-tabs .rank-mode').forEach(btn => {
  on(btn, () => { _rankHomeMode = btn.dataset.mode; renderRankingHome(); });
});
document.querySelectorAll('#rank-period-tabs .rank-period').forEach(btn => {
  on(btn, () => { _rankHomePeriod = btn.dataset.period; renderRankingHome(); });
});
// 背景タップで閉じる
const _rankingOverlayEl = document.getElementById('ranking-overlay');
if (_rankingOverlayEl) {
  _rankingOverlayEl.addEventListener('click', (e) => {
    if (e.target === _rankingOverlayEl) closeRankingHome();
  });
}

// ── モード選択シート ──
function _openModeSelectSheet() {
  const sheet   = document.getElementById('mode-select-sheet');
  const panel   = document.getElementById('play-panel');
  const btnsEl  = document.getElementById('mode-select-btns');
  if (!sheet || !btnsEl) return;

  // モードボタンを生成（tutorial 以外）
  btnsEl.innerHTML = '';
  const descMap = { time: T('modeDescTime'), endless: T('modeDescEndless'), speedrun: T('modeDescSpeedrun') };
  CFG.MODES.filter(m => m.type !== 'tutorial' && isUnlocked(m)).forEach(m => {
    const card = document.createElement('button');
    card.className = 'mode-card';
    const sec = m.timeLimit || 0;
    const timeLabel = sec ? ` ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '';
    card.innerHTML = `<span class="mc-name">${modeName(m)}${timeLabel}</span>`
                   + `<span class="mc-desc">${descMap[m.type] || ''}</span>`;
    card.addEventListener('click', () => {
      currentModeId = m.id;
      localStorage.setItem(STORAGE_KEYS.LAST_MODE, currentModeId);
      _closeModeSelectSheet();
      // エンドレスでセーブがあれば「続き / 新規」ダイアログを挟む
      if (m.id === 'endless' && _hasEndlessSave()) {
        _openEndlessResumeDialog();
      } else {
        beginGame(m.id);
      }
    });
    btnsEl.appendChild(card);
  });

  panel.style.display = 'none';
  sheet.style.display = 'flex';
}

function _closeModeSelectSheet() {
  const sheet = document.getElementById('mode-select-sheet');
  const panel = document.getElementById('play-panel');
  if (sheet) sheet.style.display = 'none';
  if (panel) panel.style.display = '';
}

// 「← 戻る」でシートを閉じてプレイパネルへ
const _modeSelectBack = document.getElementById('mode-select-back');
if (_modeSelectBack) on(_modeSelectBack, () => { playDecisionSound(); _closeModeSelectSheet(); });

// ============================================================
// エンドレス 自動セーブ / 再開
// ============================================================
// セーブ対象: 盤面の全天体(位置/速度/角度) + スコア + 次の天体 + 先読み + スキル所持数
const ENDLESS_SAVE_VER = 1;
let _endlessDirty      = false;  // 盤面が変化した（前回セーブ以降）か
let _restoringEndless  = false;  // 復元中フラグ（復元中の自動セーブを抑止）
let _resumedFromSave   = false;  // このゲームがセーブ再開由来か（ランキング送信フラグ用）

function _hasEndlessSave() {
  return !!localStorage.getItem(STORAGE_KEYS.ENDLESS_SAVE);
}
function _clearEndlessSave() {
  localStorage.removeItem(STORAGE_KEYS.ENDLESS_SAVE);
  _endlessDirty = false;
}
function _loadEndlessSave() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEYS.ENDLESS_SAVE) || 'null');
    if (!s || s.v !== ENDLESS_SAVE_VER || !Array.isArray(s.bodies)) return null;
    return s;
  } catch (_) { return null; }
}
// 現在の盤面をシリアライズして保存。endless 以外・dead・waiting では何もしない。
function _saveEndlessGame() {
  if (curMode()?.type !== 'endless' || dead || waiting) return;
  const bodies = [];
  for (const d of bmap.values()) {
    const b = d.body;
    bodies.push({
      bi: d.bi,
      x:  +b.position.x.toFixed(2), y: +b.position.y.toFixed(2),
      vx: +b.velocity.x.toFixed(3), vy: +b.velocity.y.toFixed(3),
      a:  +b.angle.toFixed(3),      va: +b.angularVelocity.toFixed(4),
    });
  }
  const save = {
    v: ENDLESS_SAVE_VER,
    score, curBi, nxtBi,
    preview: Array.isArray(_previewLookahead) ? _previewLookahead.slice() : [],
    skills: skillCharges ? { ...skillCharges } : null,
    bodies,
    savedAt: Date.now(),
  };
  try { localStorage.setItem(STORAGE_KEYS.ENDLESS_SAVE, JSON.stringify(save)); } catch (_) {}
}
// 物理 afterUpdate から呼ばれる自動セーブ判定（天体が静止したら保存）。
function _checkEndlessAutoSave() {
  if (curMode()?.type !== 'endless' || dead || paused || waiting || _restoringEndless) return;
  if (!_endlessDirty) return;
  if (typeof mq !== 'undefined' && mq.length > 0) return; // 合成待ちは未確定
  // 全天体が静止しているか
  for (const d of bmap.values()) {
    const v = d.body.velocity;
    if (Math.hypot(v.x, v.y) > 0.28) return; // まだ動いている
  }
  _saveEndlessGame();
  _endlessDirty = false;
}

// セーブから再開。init→beginGame でまっさらにしてから盤面を流し込む。
function _resumeEndless() {
  const save = _loadEndlessSave();
  if (!save) { beginGame('endless'); return; }
  init();
  _restoringEndless = true;
  beginGame('endless'); // 空盤面・スコア0 でプレイ状態へ
  // 保存盤面を流し込む
  if (skillCharges && save.skills) {
    for (const k of Object.keys(skillCharges)) {
      if (k in save.skills) skillCharges[k] = save.skills[k];
    }
  }
  for (const sb of save.bodies) {
    if (typeof sb.bi !== 'number' || sb.bi < 0 || sb.bi >= CFG.BODIES.length) continue;
    const b = spawn(sb.x, sb.y, sb.bi);
    Matter.Body.setVelocity(b, { x: sb.vx || 0, y: sb.vy || 0 });
    Matter.Body.setAngle(b, sb.a || 0);
    Matter.Body.setAngularVelocity(b, sb.va || 0);
  }
  score = Math.max(0, Math.floor(save.score || 0));
  if (typeof save.curBi === 'number') curBi = save.curBi;
  if (typeof save.nxtBi === 'number') nxtBi = save.nxtBi;
  _previewLookahead = Array.isArray(save.preview) ? save.preview.slice() : [];
  _resumedFromSave = true;
  _restoringEndless = false;
  _endlessDirty = false;
  updateHUD();
  updateSkillButtons();
}

// ── 続き/新規 ダイアログ ──
function _openEndlessResumeDialog() {
  const modal = document.getElementById('endless-resume-modal');
  if (!modal) { beginGame('endless'); return; }
  const save = _loadEndlessSave();
  _setTextById('endless-resume-title', T('endlessResumeTitle'));
  // セーブ情報: スコアと天体数
  const info = save ? T('endlessResumeInfo')(save.score || 0, (save.bodies || []).length) : '';
  _setTextById('endless-resume-info', info);
  _setTextById('endless-resume-continue', T('endlessResumeContinue'));
  _setTextById('endless-resume-new', T('endlessResumeNew'));
  modal.classList.add('show');
}
function _closeEndlessResumeDialog() {
  document.getElementById('endless-resume-modal')?.classList.remove('show');
}
function _openEndlessConfirm() {
  const modal = document.getElementById('endless-confirm-modal');
  if (!modal) return;
  _setTextById('endless-confirm-title', T('endlessConfirmTitle'));
  _setTextById('endless-confirm-cancel', T('endlessConfirmCancel'));
  _setTextById('endless-confirm-ok', T('endlessConfirmOk'));
  modal.classList.add('show');
}
function _closeEndlessConfirm() {
  document.getElementById('endless-confirm-modal')?.classList.remove('show');
}
function _setTextById(id, txt) { const e = document.getElementById(id); if (e) e.textContent = txt; }

// 続き → 復元して開始
on(document.getElementById('endless-resume-continue'), () => {
  playDecisionSound();
  _closeEndlessResumeDialog();
  _resumeEndless();
});
// 新しく始める → 確認ダイアログへ
on(document.getElementById('endless-resume-new'), () => {
  playDecisionSound();
  _openEndlessConfirm();
});
// 確認: キャンセル → 確認だけ閉じる（続き/新規ダイアログは残す）
on(document.getElementById('endless-confirm-cancel'), () => {
  playBackSound();
  _closeEndlessConfirm();
});
// 確認: OK → セーブ破棄して新規開始
on(document.getElementById('endless-confirm-ok'), () => {
  playDecisionSound();
  _clearEndlessSave();
  _closeEndlessConfirm();
  _closeEndlessResumeDialog();
  beginGame('endless');
});
// 続き/新規ダイアログ背景タップで閉じる（プレイは開始しない＝ホームへ戻る）
const _endlessResumeModalEl = document.getElementById('endless-resume-modal');
if (_endlessResumeModalEl) {
  _endlessResumeModalEl.addEventListener('click', (e) => {
    if (e.target === _endlessResumeModalEl) _closeEndlessResumeDialog();
  });
}

// ── ホーム下部バー（タブ切替）──
// プレイ=ホーム基本画面（オーバーレイを閉じる）、恒星/研究/実績/ランキングは各オーバーレイ。
function _closeAllHomeOverlays() {
  if (typeof closeRankingHome === 'function') closeRankingHome();
  if (typeof closeAchievements === 'function') closeAchievements();
}
function showHomeTab(tab) {
  _closeAllHomeOverlays();
  document.querySelectorAll('#home-nav .nav-item')
    .forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  // 研究/宇宙パネル廃止により分岐は ach / ranking / play のみ
  if      (tab === 'ranking' && typeof openRankingHome === 'function') openRankingHome();
  else if (tab === 'ach'     && typeof openAchievements === 'function') openAchievements();
  if (tab === 'play') updateModeToggle();
}
// チュートリアル完了までは「プレイ」以外を隠す。完了で一斉解禁。
function updateHomeNav() {
  const done = isStageTutorialDone();
  document.querySelectorAll('#home-nav .nav-item').forEach(b => {
    if (b.dataset.tab === 'play') return;
    b.style.display = done ? '' : 'none';
  });
  document.getElementById('home-nav')?.classList.toggle('tutorial-only', !done);
  const skipBtn = document.getElementById('skip-tutorial-btn');
  if (skipBtn) skipBtn.style.display = done ? 'none' : '';
  if (typeof _updateIntroVideo === 'function') _updateIntroVideo(); // チュートリアル完了/スキップで動画を消す
}
// チュートリアルスキップ
const _skipTutorialBtn = document.getElementById('skip-tutorial-btn');
if (_skipTutorialBtn) {
  _skipTutorialBtn.addEventListener('click', () => {
    localStorage.setItem(STORAGE_KEYS.STAGE_TUTORIAL_DONE, '1');
    localStorage.setItem(STORAGE_KEYS.TUTORIAL_DONE, '1');
    tutorialDone = true;
    const _saved = localStorage.getItem(STORAGE_KEYS.MODE);
    const _savedDef = CFG.MODES.find(m => m.id === _saved && m.type !== 'tutorial');
    currentModeId = (_savedDef && isUnlocked(_savedDef)) ? _saved : CFG.DEFAULT_MODE;
    logEvent('tutorial_skip', {
      game_id:     'rollaxy',
      game_number: parseInt(localStorage.getItem(STORAGE_KEYS.GAME_COUNT) || '0', 10),
      lang:        typeof currentLang !== 'undefined' ? currentLang : 'ja',
    });
    updateHomeNav();
    updateModeToggle();
  });
}
// バー全体のクリックを委譲（プレイは音声解除も行う）
// ランキング・実績は同じボタンをもう一度押すとプレイに戻る（トグル）
const _homeNavEl = document.getElementById('home-nav');
if (_homeNavEl) {
  _homeNavEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === 'play') _tryUnlockAudio();
    playDecisionSound();
    // すでにアクティブなタブを再押し → プレイに戻す（トグル）
    // 旧仕様: ranking / ach のみ。新仕様: research / cosmos も同様に再押しで通常表示に戻れる。
    const isActive = btn.classList.contains('active');
    const toggleable = (tab === 'ranking' || tab === 'ach' || tab === 'research' || tab === 'cosmos');
    showHomeTab(isActive && toggleable ? 'play' : tab);
  });
}

// ── モード切替トグル（モード選択オーバーレイ内） ──
// ボタン文言を現在のモード/ステージで更新する。
function updateModeToggle() {
  if (!modeToggleBtn) return;
  const m = curMode();
  if (m.type === 'tutorial') {
    // チュートリアルモードのみ: ステージ進捗をボタンに表示
    const s = curStage();
    if (s) {
      const idx   = CFG.STAGES.findIndex(x => x.id === s.id);
      const total = CFG.STAGES.length;
      modeToggleBtn.textContent = `${modeName(m)} ${idx + 1}/${total}`;
    } else {
      modeToggleBtn.textContent = modeName(m);
    }
    modeToggleBtn.style.display = '';
  } else {
    // 非チュートリアル: モードトグルボタンは不要（スタート後のシートで選ぶ）
    modeToggleBtn.style.display = 'none';
  }
  // スタート画面のチュートリアル目標説明
  const descEl = document.getElementById('start-stage-desc');
  if (descEl) {
    if (m.type === 'tutorial') { descEl.textContent = stageDesc(curStage()); descEl.style.display = ''; }
    else { descEl.style.display = 'none'; }
  }
  // ステージ選択リストを更新
  renderStageSelectList();
}

// チュートリアルモード時にステージ選択バッジ一覧を描画する。
// クリア済み → 選択可。未到達 → 選択不可。現在選択中 → ハイライト。
function renderStageSelectList() {
  const listEl = document.getElementById('stage-select-list');
  if (!listEl) return;
  const m = curMode();
  if (m.type !== 'tutorial') { listEl.style.display = 'none'; return; }

  const cleared   = loadClearedStages();
  const firstUncleared = firstUnclearedStageId();
  listEl.innerHTML = '';

  CFG.STAGES.forEach((st, idx) => {
    const isCleared  = cleared.has(st.id);
    const isCurrent  = st.id === firstUncleared; // 今回の目標ステージ
    const isSelected = st.id === currentStageId;
    const isLocked   = !isCleared && !isCurrent; // まだ到達していない

    const btn = document.createElement('button');
    btn.className = 'stage-badge'
      + (isSelected ? ' selected' : '')
      + (isCleared  ? ' cleared'  : '')
      + (isLocked   ? ' locked'   : '');
    btn.disabled = isLocked;

    const icon = isCleared ? '✓' : (isCurrent ? '▶' : '○');
    btn.innerHTML = `<span class="sb-icon">${icon}</span><span class="sb-num">${idx + 1}</span>`;
    btn.title = stageDesc(st);

    if (!isLocked) {
      btn.addEventListener('click', () => {
        currentStageId = st.id;
        updateModeToggle();
      });
    }
    listEl.appendChild(btn);
  });

  listEl.style.display = 'flex';
}
// 解禁済みモードを順に切り替える。チュートリアル完了後のみ time ⇄ endless を切替可能。
on(modeToggleBtn, () => {
  if (!isStageTutorialDone()) return; // チュートリアル中はモード切替不可
  const unlocked = CFG.MODES.filter(m => m.type !== 'tutorial' && isUnlocked(m));
  if (unlocked.length < 2) return;
  const idx = unlocked.findIndex(m => m.id === currentModeId);
  currentModeId = unlocked[(idx + 1) % unlocked.length].id;
  localStorage.setItem(STORAGE_KEYS.LAST_MODE, currentModeId);
  updateModeToggle();
  updateHUD(); // HUD の目標表示を同期
});

// ============================================================
// 設定オーバーレイの開閉
// openSettings: dead=true（ゲームオーバー中）は開かない
// ============================================================
// ユーザー操作のタイミングで一度だけ音声を解除（autoplay 制限対策）
let _audioUnlocked = false;
function _tryUnlockAudio() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  _unlockAudio();
}

function beginGame(modeId = currentModeId, stageId = currentStageId) {
  // モード/ステージを確定して記録（未解禁・無効ならデフォルトへフォールバック）。
  const m = CFG.MODES.find(x => x.id === modeId && isUnlocked(x)) || curMode();
  currentModeId = m.id;
  if (m.type === 'tutorial') {
    const s = CFG.STAGES.find(x => x.id === stageId && isUnlocked(x))
           || CFG.STAGES.find(x => x.id === firstUnclearedStageId())
           || CFG.STAGES[0];
    currentStageId = s?.id ?? null;
  }
  localStorage.setItem(STORAGE_KEYS.LAST_MODE, currentModeId);

  waiting = false;
  _idleLastInput = Date.now(); // 案内ポインターのアイドル計測を開始
  if (typeof settleEnergy === 'function') settleEnergy(); // 放置分を確定し lastSaved を更新
  _gameStartTime = Date.now(); // ゲーム開始時刻（elapsed_ms 計算用）
  _speedrunCleared = false; _speedrunClearMs = 0; // speedrun 状態リセット
  _pausedTotalMs = 0; _pauseStartedAt = 0;        // ポーズ計測リセット
  // セーブ再開フラグ: _resumeEndless が後で true に上書きする。通常開始は false。
  if (!_restoringEndless) { _resumedFromSave = false; _endlessDirty = false; }
  // 制限時間を確定（time モードは固定 timeLimit、tutorial はステージ毎の timeLimit）
  _timeLimitMs = 0;
  if (m.type === 'time' && m.timeLimit) {
    _timeLimitMs = (m.timeLimit + _metaMod('timeBonus', 0)) * 1000; // 研究で延長
  } else if (m.type === 'tutorial') {
    const st = curStage();
    if (st && st.timeLimit) _timeLimitMs = st.timeLimit * 1000;
  }
  _gameEndAt = _timeLimitMs > 0 ? Date.now() + _timeLimitMs : 0;

  // ステージの initSkills でスキル初期所持数を上書き（_resetStats が設定した値に重ねる）
  const _stInit = curStage();
  if (_stInit && _stInit.initSkills) {
    for (const [_k, _v] of Object.entries(_stInit.initSkills)) {
      if (_k in skillCharges) skillCharges[_k] = _v;
    }
  }

  // presetBodies: 初期盤面をスポーン（物理世界は _buildPhysicsWorld() 済み）
  if (_stInit && Array.isArray(_stInit.presetBodies)) {
    for (const pb of _stInit.presetBodies) {
      const b = spawn(pb.x, pb.y, pb.bi);
      // 速度をゼロにして安定した初期配置を維持
      Matter.Body.setVelocity(b, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(b, 0);
    }
  }

  document.getElementById('home-nav')?.classList.remove('show'); // 下部バーを隠す
  _closeAllHomeOverlays(); // 開いているメタオーバーレイを全て閉じる（ランキング等の残留防止）
  if (typeof stopMotivationCycle === 'function') stopMotivationCycle(); // ホームのやる気メッセージ停止
  startScreen.classList.add('hidden');       // スタート画面をフェードアウト
  hideResourceBar(); // ゲームプレイ中はリソースバーを隠す
  updateSkillButtons(); // waiting=false になったのでボタンの disabled を解除
  updateHUD();             // 目標スコア併記を反映
  updateStageObjective();  // チュートリアル目標バナーを表示
  // _unlockAudio() は最初のユーザー操作時に _tryUnlockAudio() 経由で呼ぶ
  // game_number: このブラウザで何回目のゲームか（初回=1）
  // is_returning は increment 前に確認する（初回は必ず 0 になるように）
  const _prevCount  = parseInt(localStorage.getItem(STORAGE_KEYS.GAME_COUNT) || '0', 10);
  const _gameCount  = _prevCount + 1;
  localStorage.setItem(STORAGE_KEYS.GAME_COUNT, String(_gameCount));
  logEvent('game_start', {
    game_id:            'rollaxy',
    mode:               currentModeId,
    stage:              m.type === 'tutorial' ? currentStageId : null,
    tutorial_stage_num: _tutStageNum(),
    lang:               typeof currentLang !== 'undefined' ? currentLang : 'ja',
    game_number:        _gameCount,
    is_returning:       _prevCount > 0 ? 1 : 0,
    has_display_name:   localStorage.getItem(STORAGE_KEYS.NAME_SET) ? 1 : 0,
  });
  _fetchSessionToken(); // セッショントークンをバックグラウンドで取得（ゲーム開始はブロックしない）

  // 初回ゲーム開始時のみスキルバーをパルスアニメで強調（存在に気づかせる）
  if (_gameCount === 1) {
    const skillBar = document.getElementById('skill-bar');
    skillBar.classList.add('skill-bar-highlight');
    skillBar.addEventListener('animationend', () => {
      skillBar.classList.remove('skill-bar-highlight');
    }, { once: true });
  }
}

// ゲーム開始時にサーバーからセッショントークンを非同期取得。
// 取得できなくてもゲームは続行（JWT_SECRET 未設定時は token: null が返る）。
async function _fetchSessionToken() {
  try {
    const res = await fetch('/api/session');
    if (res.ok) {
      const { token } = await res.json();
      _sessionToken = token ?? null;
    }
  } catch (_) {
    // ネットワークエラー時はトークンなしのまま続行
  }
}

// 設定オーバーレイ UI（メニュー/設定パネル・表示名保存・音量スライダー）は
// game-ui.js に分離（game.js の後にロード）。openSettings/closeSettings 等を提供。

window.addEventListener('resize', _onViewportResize);
// visualViewport は iOS/Android Chrome でアドレスバー展開時に window.resize より先に発火する
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', _onViewportResize);
}
_setVhVar(); // 初回: --app-height を DOM 構築直後に確定させる

// ============================================================
// LANG — 言語セレクターの構築と langchange イベントへの対応
// ============================================================

// 設定オーバーレイ内に言語ボタンを生成（LANG_ORDER の順）
function buildLangSelector() {
  const selector = document.getElementById('settings-lang-row');
  if (!selector) return;
  selector.innerHTML = '';
  for (const code of LANG_ORDER) {
    const btn = document.createElement('button');
    btn.className = 'lang-btn';
    btn.dataset.lang = code;
    btn.textContent = LANGS[code].name;
    if (code === currentLang) btn.classList.add('active');
    btn.addEventListener('click',     () => setLang(code));
    btn.addEventListener('touchend',  e  => { e.preventDefault(); setLang(code); }, { passive: false });
    selector.appendChild(btn);
  }
}

// lang.js の applyLang() が発火する langchange を受けてスコア等の動的文字列を再描画
document.addEventListener('langchange', () => {
  updateHUD(); // モード対応のスコア/目標表示を再描画
  hiEl.textContent    = `${T('best')}: ${hiScore}`;
  updateModeToggle(); // モード名を新言語で再描画
  updateStageObjective(); // 目標バナーを新言語で再描画
  updateRewardQueueInfo();
  updateAutoshowBtn();
  updateNameHint();
  // 表示名フィールドの placeholder を言語に合わせて更新
  const dnInput = document.getElementById('displayname-input');
  if (dnInput) dnInput.placeholder = T('displayNamePlaceholder');
});

// ============================================================
// DEBUG MODE — ` キーでトグル
// ゲーム進行はそのまま継続しつつ、任意の天体を直接配置・削除できる。
// ============================================================
const DBG_KEYS   = '1234567890-='; // 12天体のショートカット
const dbgPanel   = document.getElementById('debug-panel');
const dbgCountEl = document.getElementById('debug-count');

// デバッグ: ゲームデータを全リセットしてリロード
document.getElementById('debug-reset-btn').addEventListener('click', () => {
  const keep = new Set([STORAGE_KEYS.LANG, STORAGE_KEYS.DISPLAY_NAME, STORAGE_KEYS.SFX_VOL]);
  Object.keys(localStorage)
    .filter(k => !keep.has(k))
    .forEach(k => localStorage.removeItem(k));
  location.reload();
});

// デバッグ: 各種ボタン操作。研究/宇宙廃止に伴い当面はスコア関連のみ
document.querySelectorAll('.debug-action-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const a = btn.dataset.action;
    if (a === 'score+1000') { score += 1000; updateHUD(); }
    else if (a === 'score+10000') { score += 10000; updateHUD(); }
    else if (a === 'clear_hi') { localStorage.removeItem(STORAGE_KEYS.HI_SCORE); localStorage.removeItem(STORAGE_KEYS.BEST_SCORE); localStorage.removeItem(STORAGE_KEYS.BEST_SCORE_TIME); }
  });
});

function buildDebugPalette() {
  const container = document.getElementById('debug-palette');
  CFG.BODIES.forEach((def, i) => {
    const btn = document.createElement('button');
    btn.className = 'dbg-btn';
    btn.dataset.bi = i;
    btn.innerHTML =
      `<span class="dbg-key">${DBG_KEYS[i]}</span>` +
      `<span class="dbg-emoji">${def.e}</span>`;
    btn.title = `${def.n}  r=${def.r}  score=${def.s}`;
    btn.addEventListener('click', () => debugSelectBi(i));
    container.appendChild(btn);
  });
  debugSelectBi(0);
}

function debugSelectBi(i) {
  debugBi = i;
  document.querySelectorAll('.dbg-btn').forEach((b, j) => b.classList.toggle('active', j === i));
}

function toggleDebugMode() {
  debugMode = !debugMode;
  dbgPanel.classList.toggle('show', debugMode);
  outer.classList.toggle('debug-active', debugMode);
  debugDragging = false;
}

// 天体をゲームフィールド内に直接配置
function debugPlace(lx, ly) {
  if (lx < CFG.BOX.L || lx > CFG.BOX.R || ly < CFG.BOX.T || ly > CFG.BOX.B) return;
  spawn(lx, ly, debugBi);
  dbgCountEl.textContent = bmap.size + ' bodies';
}

// クリック位置に最も近い天体を削除
function debugRemove(lx, ly) {
  for (const [id, d] of bmap.entries()) {
    const dx = d.body.position.x - lx;
    const dy = d.body.position.y - ly;
    if (dx * dx + dy * dy <= CFG.BODIES[d.bi].r * CFG.BODIES[d.bi].r) {
      bmap.delete(id); glowMap.delete(id);
      Matter.Composite.remove(world, d.body, true);
      dbgCountEl.textContent = bmap.size + ' bodies';
      return;
    }
  }
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  // ` でデバッグモードをトグル
  if (e.key === '`') { toggleDebugMode(); return; }
  if (!debugMode) return;
  // 1–= で天体選択
  const ki = DBG_KEYS.indexOf(e.key);
  if (ki !== -1 && ki < CFG.BODIES.length) { debugSelectBi(ki); return; }
  // Shift+R で全天体クリア（誤爆防止のため Shift 必須）
  if (e.key === 'R') {
    for (const [id, d] of bmap.entries()) {
      glowMap.delete(id);
      Matter.Composite.remove(world, d.body, true);
    }
    bmap.clear();
    dbgCountEl.textContent = '0 bodies';
  }
});

// ============================================================
// START
// ============================================================
buildDebugPalette();
buildLangSelector();
applyLang();
init();
// 初回アクセスでも必ずスタート画面を表示する（自動開始しない）。
updateStartPlayername();
updateNameHint();
updateAutoshowBtn(); // game-skills.js のロード時点では choiceAutoShow 未定義のためここで呼ぶ
requestAnimationFrame(loop);
