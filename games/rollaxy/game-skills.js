'use strict';

// ============================================================
// SKILLS — DOM refs
// ============================================================
const skillBombBtn    = document.getElementById('skill-bomb');
const skillUpgradeBtn = document.getElementById('skill-upgrade');
const skillDeleteBtn  = document.getElementById('skill-delete');
const skillBombCount    = document.getElementById('skill-bomb-count');
const skillUpgradeCount = document.getElementById('skill-upgrade-count');
const skillDeleteCount  = document.getElementById('skill-delete-count');
const skillConfirmEl  = document.getElementById('skill-confirm');
const confirmPreviewEl = document.getElementById('confirm-preview');
const confirmOkBtn    = document.getElementById('confirm-ok');
const confirmCancelBtn = document.getElementById('confirm-cancel');

// ============================================================
// 爆弾スキル
// ============================================================

// 爆弾を物理ワールドに生成（bmap には登録しない → 合成対象外）
function spawnBomb(x, y) {
  const b = Matter.Bodies.circle(x, y, CFG.BOMB.R, {
    label: 'bomb',
    friction: CFG.PHYS.FRIC, frictionAir: CFG.PHYS.FRIC_AIR,
    frictionStatic: CFG.PHYS.FRIC_S, restitution: CFG.PHYS.REST, slop: CFG.PHYS.SLOP,
  });
  Matter.Composite.add(world, b);
  return b;
}

// 爆弾が何かに衝突したら導火線を開始
function startBombFuse() {
  if (bombFuseTimer) return; // すでに点火済み
  bombHit = true;
  bombFuseTimer = setTimeout(() => {
    if (bombBody) explodeBomb({ x: bombBody.position.x, y: bombBody.position.y });
  }, CFG.BOMB.FUSE_MS);
}

// 爆発処理: SAFE_BI 未満の天体を効果範囲内で消去
function explodeBomb(pos) {
  playExplosionSound();
  bombExplosion = { x: pos.x, y: pos.y, startTime: Date.now(), duration: 500 };

  const toRemove = [];    // bi < SAFE_BI  → 即消滅
  const toDowngrade = []; // SAFE_BI <= bi <= DOWNGRADE_BI → 1段階ダウン
  for (const [id, d] of bmap.entries()) {
    const dx = d.body.position.x - pos.x;
    const dy = d.body.position.y - pos.y;
    // 爆発円(RANGE)と天体円(body.r)の重なり判定: center距離 <= RANGE + body.r
    const eff = CFG.BOMB.RANGE + d.body.circleRadius;
    if (dx * dx + dy * dy > eff * eff) continue;
    if (d.bi < CFG.BOMB.SAFE_BI) {
      toRemove.push({ id, body: d.body });
    } else if (d.bi <= CFG.BOMB.DOWNGRADE_BI) {
      toDowngrade.push({ id, body: d.body, bi: d.bi });
    }
    // bi > DOWNGRADE_BI (ブラックホール以上) は影響なし
  }
  for (const { id, body } of toRemove) {
    bmap.delete(id); glowMap.delete(id);
    Matter.Composite.remove(world, body, true);
  }
  for (const { id, body, bi } of toDowngrade) {
    const px = body.position.x, py = body.position.y;
    bmap.delete(id); glowMap.delete(id);
    Matter.Composite.remove(world, body, true);
    spawn(px, py, bi - 1);
  }

  if (bombBody) { Matter.Composite.remove(world, bombBody, true); bombBody = null; }
  bombFuseTimer = null; bombHit = false;
  notifySkillUsed(); // スキル（爆弾）が適用された
  wakeAllBodies();
}

// ============================================================
// 強制スキルバナー（専用 canvas オーバーレイ）
// ============================================================
const _fsCanvas = document.getElementById('forced-skill-canvas');
const _fsCtx    = _fsCanvas.getContext('2d');
const _FS_COLORS = { bomb: '#ffcc44', upgrade: '#cc88ff', delete: '#ff8888' };
let _fsRafId  = null;
let _fsActive = false;

function _sizeFsCanvas() {
  const s  = (typeof _canvasScale   !== 'undefined' && _canvasScale   > 0) ? _canvasScale   : 1;
  const ox = (typeof _canvasOffsetX !== 'undefined')                       ? _canvasOffsetX : 0;
  const barH = Math.round(CFG.BAR_H * s);
  const cssW = Math.round(CFG.W * s);
  const cssH = Math.round(68 * s); // ヘッダー相当の高さ
  _fsCanvas.style.left   = ox + 'px';
  _fsCanvas.style.top    = barH + 'px';
  _fsCanvas.style.width  = cssW + 'px';
  _fsCanvas.style.height = cssH + 'px';
}

function _drawFsCanvas(t) {
  const dpr = window.devicePixelRatio || 1;
  const w   = _fsCanvas.offsetWidth;
  const h   = _fsCanvas.offsetHeight;
  if (!w || !h) return;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (_fsCanvas.width !== pw || _fsCanvas.height !== ph) {
    _fsCanvas.width  = pw;
    _fsCanvas.height = ph;
  }
  const ctx   = _fsCtx;
  const color = _FS_COLORS[activeSkill] || '#ffffff';
  const pulse = 0.5 + 0.5 * Math.sin(t * 0.003);
  ctx.clearRect(0, 0, pw, ph);
  ctx.save();
  ctx.scale(dpr, dpr);

  const pad = 6, r = 10;
  const bx = pad, by = pad, bw = w - pad * 2, bh = h - pad * 2;

  // 背景
  ctx.fillStyle = 'rgba(10, 4, 24, 0.93)';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, r); ctx.fill();

  // 縁のグロー（多重描画で強調）
  const glow = 6 + 18 * pulse;
  ctx.shadowColor = color; ctx.shadowBlur = glow;
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, r); ctx.stroke();
  ctx.shadowBlur = glow * 0.5;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, r); ctx.stroke();
  ctx.shadowBlur = 0;

  const cap   = activeSkill.charAt(0).toUpperCase() + activeSkill.slice(1);
  const title = T('forcedTitle' + cap);
  const desc  = T('forcedDesc'  + cap);
  const titleSz = Math.round(h * 0.40);
  const descSz  = Math.round(h * 0.24);

  // タイトル
  ctx.fillStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 8;
  ctx.font = `bold ${titleSz}px -apple-system,'Helvetica Neue',Arial,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, w / 2, h * 0.52);
  ctx.shadowBlur = 0;

  // 説明
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.font = `${descSz}px -apple-system,'Helvetica Neue',Arial,sans-serif`;
  ctx.fillText(desc, w / 2, h * 0.84);

  ctx.restore();
}

function _fsBannerLoop(t) {
  if (!_fsActive) return;
  _drawFsCanvas(t);
  _fsRafId = requestAnimationFrame(_fsBannerLoop);
}

function updateForcedSkillBanner() {
  if (_forcedSkillActive && activeSkill) {
    _sizeFsCanvas();
    _fsCanvas.style.display = 'block';
    _fsActive = true;
    if (!_fsRafId) _fsRafId = requestAnimationFrame(_fsBannerLoop);
  } else {
    _fsActive = false;
    if (_fsRafId) { cancelAnimationFrame(_fsRafId); _fsRafId = null; }
    _fsCtx.clearRect(0, 0, _fsCanvas.width, _fsCanvas.height);
    _fsCanvas.style.display = 'none';
  }
}

window.addEventListener('resize', () => { if (_fsActive) _sizeFsCanvas(); });
document.addEventListener('langchange', () => { if (_fsActive) updateForcedSkillBanner(); });

// ============================================================
// スキル共通管理
// ============================================================

function updateSkillButtons() {
  skillBombBtn.classList.toggle('active',      activeSkill === 'bomb');
  skillUpgradeBtn.classList.toggle('active',   activeSkill === 'upgrade');
  skillDeleteBtn.classList.toggle('active',    activeSkill === 'delete');
  skillUpgradeBtn.classList.toggle('select-mode', activeSkill === 'upgrade' && skillSelectMode);
  skillDeleteBtn.classList.toggle('select-mode',  activeSkill === 'delete'  && skillSelectMode);

  // 所持数バッジを更新（Infinity は ∞ 表示）
  const fmt = n => n === Infinity ? '∞' : String(n);
  skillBombCount.textContent    = fmt(skillCharges.bomb);
  skillUpgradeCount.textContent = fmt(skillCharges.upgrade);
  skillDeleteCount.textContent  = fmt(skillCharges.delete);

  // 所持数 0 / ゲーム非アクティブ / チュートリアル・強制使用中は無効化
  const inactive = dead || waiting || tutorialActive || _forcedSkillActive;
  skillBombBtn.disabled    = inactive || skillCharges.bomb    === 0;
  skillUpgradeBtn.disabled = inactive || skillCharges.upgrade === 0;
  skillDeleteBtn.disabled  = inactive || skillCharges.delete  === 0;
}

function resetSkillState() {
  activeSkill = null; bombMode = false;
  skillSelectMode = false; skillSelectedId = null;
  skillConfirmEl.classList.remove('show');
  updateSkillButtons();
  updateForcedSkillBanner();
}

// ── 初回タップ時のワンショットトースト ──
const _SKILL_HINT_KEYS = {
  bomb:    STORAGE_KEYS.SKILL_HINT_BOMB,
  upgrade: STORAGE_KEYS.SKILL_HINT_UPGRADE,
  delete:  STORAGE_KEYS.SKILL_HINT_DELETE,
};
const _SKILL_HINT_LANG_KEYS = {
  bomb:    'skillHintBomb',
  upgrade: 'skillHintUpgrade',
  delete:  'skillHintDelete',
};
let _skillToastTimer = null;
const _skillToastEl = document.getElementById('skill-toast');

function showSkillHintToast(skill) {
  if (!_skillToastEl) return;
  const lsKey = _SKILL_HINT_KEYS[skill];
  if (localStorage.getItem(lsKey)) return; // 表示済み
  localStorage.setItem(lsKey, '1');

  clearTimeout(_skillToastTimer);
  _skillToastEl.classList.remove('hiding');
  _skillToastEl.textContent = T(_SKILL_HINT_LANG_KEYS[skill]);
  _skillToastEl.style.display = '';

  _skillToastTimer = setTimeout(() => {
    _skillToastEl.classList.add('hiding');
    _skillToastEl.addEventListener('animationend', () => {
      _skillToastEl.style.display = 'none';
      _skillToastEl.classList.remove('hiding');
    }, { once: true });
  }, 3000);
}

// スキルボタンを押したときの処理（同じスキルならトグルオフ）
function setActiveSkill(skill) {
  if (dead || waiting) return;
  if (tutorialActive || _forcedSkillActive) return; // 強制/チュートリアル中は切替不可
  if (activeSkill === skill) { resetSkillState(); return; } // トグルオフ

  // 既存スキルをキャンセルしてから新スキルを有効化
  playSkillSelectSound();
  skillConfirmEl.classList.remove('show');
  activeSkill = skill;
  bombMode = (skill === 'bomb');
  skillSelectMode = (skill === 'upgrade' || skill === 'delete');
  skillSelectedId = null;
  updateSkillButtons();
  showSkillHintToast(skill); // 初回タップ時のみトーストを表示
}

// ============================================================
// 天体選択モード（upgrade / delete）
// ============================================================

function toLogicalY(clientY) {
  const r = canvas.getBoundingClientRect();
  return (clientY - r.top) * (CFG.H / r.height);
}

// canvas タップ時に天体を選択する
function handleSelectTap(lx, ly) {
  if (skillSelectedId !== null) return; // 既に選択済み（確認パネル表示中）
  for (const [id, d] of bmap.entries()) {
    const r = CFG.BODIES[d.bi].r;
    const dx = lx - d.body.position.x;
    const dy = ly - d.body.position.y;
    if (dx * dx + dy * dy > r * r) continue;
    // upgrade の場合、最上位（銀河団 bi=11）は選択不可
    if (activeSkill === 'upgrade' && d.bi >= CFG.BODIES.length - 1) continue;
    skillSelectedId = id;
    if (tutorialActive) {
      // チュートリアル: 確認パネルなしで即適用
      confirmSkillAction();
    } else {
      showConfirmPanel(id);
    }
    return;
  }
}

function bodyImgTag(bi) {
  const img = bodyImages[bi];
  if (img && img.complete && img.naturalWidth > 0) {
    return `<img src="images/${CFG.BODIES[bi].key}.png" style="height:44px;vertical-align:middle">`;
  }
  return CFG.BODIES[bi].e;
}

function showConfirmPanel(bodyId) {
  const d = bmap.get(bodyId);
  if (!d) return;
  if (activeSkill === 'upgrade') {
    confirmPreviewEl.innerHTML = `${bodyImgTag(d.bi)}&nbsp;→&nbsp;${bodyImgTag(d.bi + 1)}`;
  } else {
    confirmPreviewEl.innerHTML = `${bodyImgTag(d.bi)}&nbsp;${T('confirmDelete')}`;
  }
  skillConfirmEl.classList.add('show');
}

function confirmSkillAction() {
  const d = bmap.get(skillSelectedId);
  if (!d) { resetSkillState(); return; }

  if (activeSkill === 'upgrade') {
    playUpgradeSound();
    const ni = d.bi + 1;
    bmap.delete(skillSelectedId); glowMap.delete(skillSelectedId);
    Matter.Composite.remove(world, d.body, true);
    const nb = spawn(d.body.position.x, d.body.position.y, ni);
    const dur = 300 + ni * 100;
    glowMap.set(nb.id, { endTime: Date.now() + dur, duration: dur });
    if (ni > _maxTierThisGame) _maxTierThisGame = ni; // requireTier 判定用（スキル強化経路）
    if (skillCharges.upgrade !== Infinity) skillCharges.upgrade--;
    notifySkillUsed(); // スキル（強化）が適用された
    noteSkillUsed('upgrade'); // チュートリアル目標判定用
    // speedrun: 強化で銀河団 (bi=CFG.BODIES.length-1) を作った場合もクリア判定
    if (ni === CFG.BODIES.length - 1 && curMode()?.type === 'speedrun' && !_speedrunCleared) {
      _speedrunCleared = true;
      _speedrunClearMs = Date.now() - _gameStartTime;
      setTimeout(() => doSpeedrunClear(), 50);
    }
  } else if (activeSkill === 'delete') {
    playDeleteSound();
    bmap.delete(skillSelectedId); glowMap.delete(skillSelectedId);
    Matter.Composite.remove(world, d.body, true);
    if (skillCharges.delete !== Infinity) skillCharges.delete--;
    notifySkillUsed(); // スキル（削除）が適用された
    noteSkillUsed('delete'); // チュートリアル目標判定用
  }

  // 操作後に全ボディの sleep を解除する。
  wakeAllBodies();

  // チュートリアル・強制使用の後処理
  const wasTutorial = tutorialActive;
  const wasForced   = _forcedSkillActive;
  _sessionEverUsedSkill = true; // 強制・チュートリアル問わず「使った」として強調を解除

  resetSkillState();

  if (wasTutorial) {
    completeTutorial();
  } else if (wasForced) {
    _forcedSkillActive = false;
    onForcedSkillUsed();
  }
  updateReminderHighlight();
}

// bmap 内の全天体を sleep から起こす
function wakeAllBodies() {
  const now = Date.now();
  for (const d of bmap.values()) {
    Matter.Sleeping.set(d.body, false);
    d._sc = null; // 振動検出カウンタをリセット（wake 後は改めて計測する）
    d.at  = now;  // SLEEP_GRACE_MS の猶予をリセット
    // Matter.js 組み込み sleep が即座に再スリープするのを防ぐため
    // 静止天体に微小な下方速度を与える。支持されている天体では
    // 接触拘束が即座に打ち消すため実質的な移動は発生しない。
    if (d.body.speed < 0.1) {
      Matter.Body.setVelocity(d.body, {
        x: d.body.velocity.x,
        y: d.body.velocity.y + 0.15,
      });
    }
  }
}

function cancelSkillAction() {
  if (tutorialActive) return; // チュートリアル中はキャンセル不可
  // 強制スキル中も選び直しを許可（スキル自体はキャンセルできない）
  playBackSound();
  skillSelectedId = null;
  skillConfirmEl.classList.remove('show');
  updateSkillButtons();
}

// ============================================================
// 4連鎖ルーレット
// ============================================================
const RLT_SKILLS  = ['bomb', 'upgrade', 'delete'];
const RLT_SPIN_MS = 90;  // 通常スピード (ms/ステップ)
const RLT_DECEL   = [110, 160, 225, 315, 440]; // 減速ステップの間隔 (ms)
let rltPos = 0, rltTarget = 0, rltTimer = null, rltAutoTimer = null, rltStopping = false;
let _rltTimerPauseStart = 0; // タイムアタック: ルーレット開始時刻（_gameEndAt 補正用）

function showRoulette() {
  rouletteActive = true;
  rltStopping    = false;
  if (typeof _timeLimitMs !== 'undefined' && _timeLimitMs > 0) _rltTimerPauseStart = Date.now();
  rltPos         = 0;
  // 当選スキルはランダム（初回オンボーディングはチュートリアルへ移行済み）
  rltTarget = Math.floor(Math.random() * 3);
  document.getElementById('roulette-stop').disabled = false;
  document.getElementById('roulette-overlay').classList.add('show');
  rltSetHighlight(RLT_SPIN_MS);
  rltScheduleSpin(RLT_SPIN_MS);
  rltAutoTimer = setTimeout(rltStop, 1800); // 1.8秒で自動停止
}

function rltScheduleSpin(delay) {
  rltTimer = setTimeout(() => {
    rltPos = (rltPos + 1) % 3;
    rltSetHighlight(RLT_SPIN_MS);
    rltScheduleSpin(RLT_SPIN_MS);
  }, delay);
}

function rltStop() {
  if (rltStopping || !rouletteActive) return;
  rltStopping = true;
  clearTimeout(rltTimer);
  clearTimeout(rltAutoTimer);
  document.getElementById('roulette-stop').disabled = true;
  // 現在位置からtargetに向かって4〜6ステップ減速して止まるシーケンスを生成
  const rem   = ((rltTarget - rltPos) % 3 + 3) % 3;
  const total = rem === 0 ? 3 : rem + 3; // 3〜5ステップ (最低でも一巡)
  rltRunDecel(total, 0);
}

function rltRunDecel(total, step) {
  if (step >= total) { rltFinish(); return; }
  const delay = RLT_DECEL[Math.min(step, RLT_DECEL.length - 1)];
  rltPos = (rltPos + 1) % 3;
  rltSetHighlight(delay);
  rltTimer = setTimeout(() => rltRunDecel(total, step + 1), delay);
}

function rltSetHighlight(transMs) {
  const t = Math.min(transMs * 0.75, 200); // transition duration
  document.querySelectorAll('.rlt-card').forEach((card, i) => {
    card.style.transition = `background ${t}ms ease, border-color ${t}ms ease, box-shadow ${t}ms ease`;
    card.classList.toggle('active', i === rltPos);
  });
}

function rltFinish() {
  // 結果を500ms見せてから処理
  setTimeout(() => {
    const skill = RLT_SKILLS[rltTarget];
    document.getElementById('roulette-overlay').classList.remove('show');
    rouletteActive = false;

    // 4連鎖の当選スキルを即時強制使用（通常仕様）。
    // 次のルーレットはスキル使用完了後に onForcedSkillUsed() で処理。
    // タイマー補正は強制スキル使用完了時（onForcedSkillUsed）に行う。
    activateForcedSkill(skill);
  }, 500);
}

function rltReset() {
  clearTimeout(rltTimer); clearTimeout(rltAutoTimer);
  rouletteActive = false; rltStopping = false;
  _rltTimerPauseStart = 0;
  document.getElementById('roulette-overlay').classList.remove('show');
}

// ============================================================
// 連鎖報酬管理（ルーレットと選択は独立）
// ============================================================

// ルーレットをキューに積む。表示中でなければ即開始
function enqueueRoulette() {
  if (dead) return; // ゲームオーバー後は報酬を与えない
  rouletteQueue.push(true);
  if (!rouletteActive) processNextRoulette();
}

function processNextRoulette() {
  if (rouletteQueue.length === 0) return;
  if (_forcedSkillActive || tutorialActive) return; // 強制使用完了まで待機
  rouletteQueue.shift();
  showRoulette();
}

// 5連鎖報酬をカウントアップして、状況に応じてパネルを表示
function enqueueChoice() {
  if (dead) return; // ゲームオーバー後は報酬を与えない
  _session5ChainCount++;
  pendingChoiceRewards++;
  updateRewardQueueInfo();
  updateSkillBarRewardState();
  updateReminderHighlight();
  if (chainRewardPending) return; // すでにパネル開放中 → カウント更新だけ
  if (pendingChoiceRewards === 1 && choiceAutoShow) {
    showChainRewardPanel(); // 初回かつ自動表示ON → フルパネル
  } else {
    peekChoicePanel(); // 追加報酬 or 自動表示OFF → 引き込みピーク演出
  }
}

// 報酬ボタンに引き込まれる短時間ピーク演出（ドロップをブロックしない）
function peekChoicePanel() {
  const panel = document.getElementById('chain-reward');
  clearTimeout(choicePeekTimer);
  // リセットして再アニメーション
  panel.classList.remove('show', 'panel-peek', 'panel-peek-out');
  void panel.offsetWidth;
  panel.classList.add('show', 'panel-peek');
  choicePeekTimer = setTimeout(() => {
    panel.classList.add('panel-peek-out');
    choicePeekTimer = setTimeout(() => {
      panel.classList.remove('show', 'panel-peek', 'panel-peek-out');
      choicePeekTimer = null;
    }, 380);
  }, 1400);
}

// 5連鎖報酬: スキル選択パネルを表示（ドロップをブロック）
// manual=true のとき（ユーザーが自力で開いた場合）は自動タイマーをセットしない
let _choicePanelManual = false;

function showChainRewardPanel(manual = false) {
  _choicePanelManual = manual;
  // ピーク演出中なら中断してフルパネルに切り替え
  clearTimeout(choicePeekTimer); choicePeekTimer = null;
  const panel = document.getElementById('chain-reward');
  panel.classList.remove('panel-peek', 'panel-peek-out');
  updateRewardQueueInfo();
  chainRewardPending = true;
  panel.classList.add('show');
  clearTimeout(choiceAutoTimer);
  if (!manual) {
    choiceAutoTimer = setTimeout(closeChoicePanel, 5000); // 自動表示時のみ5秒で閉じる
  } else {
    choiceAutoTimer = null; // 手動で開いた場合は自動で閉じない
  }
}

function closeChoicePanel() {
  clearTimeout(choiceAutoTimer); choiceAutoTimer = null;
  clearTimeout(choicePeekTimer); choicePeekTimer = null;
  _choicePanelManual = false;
  chainRewardPending = false;
  const panel = document.getElementById('chain-reward');
  panel.classList.remove('show', 'panel-peek', 'panel-peek-out');
  updateSkillBarRewardState();
}

// スキル選択完了時の処理
function onChoicePicked(skill) {
  if (pendingChoiceRewards <= 0) return;
  playDecisionSound();
  if (skillCharges[skill] !== Infinity) skillCharges[skill]++;
  updateSkillButtons();
  pendingChoiceRewards--;
  _sessionEverClaimed = true; // 報酬を受け取った
  updateRewardQueueInfo();
  if (pendingChoiceRewards > 0) {
    // まだ残りあり: 手動開放中はタイマーなし、自動開放中はタイマーリセット
    if (!_choicePanelManual) {
      clearTimeout(choiceAutoTimer);
      choiceAutoTimer = setTimeout(closeChoicePanel, 5000);
    }
  } else {
    closeChoicePanel();
  }
  updateSkillBarRewardState();
  updateReminderHighlight();
}

// 各オーバーレイの待機件数表示を更新
function updateRewardQueueInfo() {
  const rltRem = rouletteQueue.length;
  document.getElementById('roulette-queue-info').textContent =
    rltRem > 0 ? T('queueWaiting')(rltRem) : '';
  const choiceRem = chainRewardPending ? pendingChoiceRewards - 1 : pendingChoiceRewards;
  document.getElementById('choice-queue-info').textContent =
    choiceRem > 0 ? T('queueMore')(choiceRem) : '';
}

// スキルバーの報酬待機状態（縮小 + クレームボタン）を更新
function updateSkillBarRewardState() {
  const skillBar   = document.getElementById('skill-bar');
  const claimBtn   = document.getElementById('skill-claim');
  const claimCount = document.getElementById('skill-claim-count');
  if (pendingChoiceRewards > 0) {
    skillBar.classList.add('reward-pending');
    claimCount.textContent = pendingChoiceRewards;
    show(claimBtn);
  } else {
    skillBar.classList.remove('reward-pending');
    hide(claimBtn);
  }
}

// 設定画面: 報酬自動表示トグル
const autoshowBtn = document.getElementById('autoshow-btn');
function updateAutoshowBtn() {
  autoshowBtn.textContent = T('autoshow')(choiceAutoShow);
}
autoshowBtn.addEventListener('click', () => {
  choiceAutoShow = !choiceAutoShow;
  updateAutoshowBtn();
});

// ============================================================
// チュートリアル・強制使用ヘルパー
// ============================================================

// スキルをプログラム的に直接有効化（ボタンガードを経由しない）
function _activateSkillDirect(skill) {
  activeSkill    = skill;
  bombMode       = (skill === 'bomb');
  skillSelectMode= (skill === 'upgrade' || skill === 'delete');
  skillSelectedId= null;
  updateSkillButtons();
}

// 4連鎖後の強制即時使用: チャージを1追加して即有効化
function activateForcedSkill(skill) {
  if (skillCharges[skill] !== Infinity) skillCharges[skill]++;
  _forcedSkillActive = true;
  _activateSkillDirect(skill);
  updateForcedSkillBanner();
}

// 強制スキル使用完了時（upgrade/delete は confirmSkillAction、bomb は drop から呼ばれる）
function onForcedSkillUsed() {
  // タイムアタック: ルーレット開始〜スキル使用完了までの経過時間を _gameEndAt に加算
  if (typeof _timeLimitMs !== 'undefined' && _timeLimitMs > 0 &&
      typeof _gameEndAt !== 'undefined' && _gameEndAt > 0 &&
      _rltTimerPauseStart > 0) {
    _gameEndAt += Date.now() - _rltTimerPauseStart;
    _rltTimerPauseStart = 0;
  }

  _forcedSkillActive = false;
  updateForcedSkillBanner();
  updateSkillButtons();
  updateReminderHighlight();
  if (rouletteQueue.length > 0) setTimeout(processNextRoulette, 350);
}

// ---- チュートリアル ----

// アップグレード可能な最大天体のIDを返す
function findLargestUpgradableBodyId() {
  let maxBi = -1, maxId = null;
  for (const [id, d] of bmap.entries()) {
    if (d.bi > maxBi && d.bi < CFG.BODIES.length - 1) {
      maxBi = d.bi; maxId = id;
    }
  }
  return maxId;
}

// チュートリアル: upgrade強制使用モードを開始してポインターを表示
function startTutorialForcedUpgrade() {
  const targetId = findLargestUpgradableBodyId();
  if (!targetId) {
    // 強化できる天体がない場合はチュートリアルをスキップ
    return;
  }
  tutorialTargetId = targetId;
  tutorialActive   = true;
  // upgrade を強制有効化（チャージ不要: tutorial は無償）
  if (skillCharges.upgrade !== Infinity) skillCharges.upgrade++;
  _activateSkillDirect('upgrade');
  showTutorialPointer();
}

// チュートリアル完了
function completeTutorial() {
  tutorialActive   = false;
  tutorialTargetId = null;
  hideTutorialPointer();
  updateSkillButtons(); // ボタン再有効化
}

// ポインターを表示
function showTutorialPointer() {
  const ptr = document.getElementById('tutorial-pointer');
  document.getElementById('tut-text').textContent = T('tutHint');
  ptr.classList.add('show');
}

// ポインターを非表示
function hideTutorialPointer() {
  const ptr = document.getElementById('tutorial-pointer');
  if (ptr) ptr.classList.remove('show');
}

// ポインター位置を毎フレーム更新（loop() から呼ばれる）
function updateTutorialPointerEl() {
  if (!tutorialActive) return;
  // ターゲットが消えた（合成など）場合は最大天体を再検索
  if (!tutorialTargetId || !bmap.has(tutorialTargetId)) {
    tutorialTargetId = findLargestUpgradableBodyId();
    if (!tutorialTargetId) { hideTutorialPointer(); return; }
  }
  const ptr = document.getElementById('tutorial-pointer');
  if (!ptr.classList.contains('show')) return;
  const d = bmap.get(tutorialTargetId);
  if (!d) return;

  // 論理座標 → canvas-outer 内 CSS 座標（resize() がキャッシュした値を使用）
  const cx     = _canvasOffsetX + d.body.position.x * _canvasScale;
  const cy     = d.body.position.y * _canvasScale;
  const radius = d.body.circleRadius * _canvasScale;

  ptr.style.left      = cx + 'px';
  ptr.style.top       = (cy - radius - 8) + 'px'; // 天体の上端から8px上
  // transform で下端が基準点になるよう調整（translateX(-50%) は style.cssに定義済み）
}

// ---- リマインダーハイライト ----

function updateReminderHighlight() {
  const totalCharges = skillCharges.bomb + skillCharges.upgrade + skillCharges.delete;
  const claimBtn = document.getElementById('skill-claim');

  // 報酬クレームボタン: 2回目以降の5連鎖で一度も報酬を受け取っていない場合に強調
  const claimHighlight =
    pendingChoiceRewards > 0 &&
    _session5ChainCount >= 2 &&
    !_sessionEverClaimed;
  if (claimBtn) claimBtn.classList.toggle('skill-highlight', claimHighlight);

  // スキルボタン: 報酬を受け取ったがスキルを一度も使っていない場合に強調
  const skillHighlight =
    totalCharges > 0 &&
    _sessionEverClaimed &&
    !_sessionEverUsedSkill;
  skillBombBtn.classList.toggle(   'skill-highlight', skillHighlight && skillCharges.bomb    > 0);
  skillUpgradeBtn.classList.toggle('skill-highlight', skillHighlight && skillCharges.upgrade > 0);
  skillDeleteBtn.classList.toggle( 'skill-highlight', skillHighlight && skillCharges.delete  > 0);
}

// ============================================================
// イベントリスナー（スキルボタン / 確認パネル / ルーレット / 連鎖報酬）
// ============================================================

// スキルボタン
on(skillBombBtn,    () => setActiveSkill('bomb'));
on(skillUpgradeBtn, () => setActiveSkill('upgrade'));
on(skillDeleteBtn,  () => setActiveSkill('delete'));

// 確認パネルボタン
on(confirmOkBtn,     () => confirmSkillAction());
on(confirmCancelBtn, () => cancelSkillAction());

// 4連鎖ルーレット停止ボタン
const rouletteStopBtn = document.getElementById('roulette-stop');
on(rouletteStopBtn, () => rltStop());

// Space キーでルーレット停止（PCショートカット）
document.addEventListener('keydown', e => {
  if (e.key === ' ' && rouletteActive) { e.preventDefault(); rltStop(); }
});

// 連鎖報酬スキル選択ボタン
document.querySelectorAll('.chain-reward-btn').forEach(btn => {
  on(btn, () => onChoicePicked(btn.dataset.skill));
});

// スキルバーのクレームボタン（報酬待機中に表示）
const skillClaimBtn = document.getElementById('skill-claim');
const claimOpen = () => {
  if (dead) return;
  if (chainRewardPending) {
    closeChoicePanel(); // パネルが開いているときは閉じる（トグル）
  } else if (pendingChoiceRewards > 0) {
    showChainRewardPanel(true);
  }
};
on(skillClaimBtn, claimOpen);
