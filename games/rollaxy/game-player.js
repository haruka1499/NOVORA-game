'use strict';

// ============================================================
// PLAYER — GA4 イベント / プレイヤーID / 表示名管理
// ============================================================

// デバイス情報（起動時に一度だけ収集）
// pointer: coarse = タッチ/スタイラス、fine = マウス
// _dpr は game.js で定義。未定義時は window.devicePixelRatio を参照
const _DEVICE_PARAMS = {
  device_type:  navigator.maxTouchPoints > 0 ? 'touch' : 'mouse',
  pixel_ratio:  Math.round((window.devicePixelRatio || 1) * 10) / 10,
  screen_w:     screen.width,
  screen_h:     screen.height,
};

// すべての gtag('event', ...) はこの関数を経由することで
// ・呼び出し漏れチェック（typeof gtag）
// ・パラメータ共通化（game_id 等）
// ・将来のイベント名変更をここ1か所で吸収できる。
function logEvent(eventName, params = {}) {
  if (typeof gtag !== 'function') return;
  gtag('event', eventName, params);
}

// デバイス情報をデフォルトパラメータとして GA4 に設定
// これにより以降の全イベントに device_type / pixel_ratio が自動付与される
if (typeof gtag === 'function') {
  gtag('set', { ..._DEVICE_PARAMS });
}

// ============================================================
// プレイヤー識別（ゲストID）
// フォーマット: guest_{12文字英数字}
// 将来の Google/Discord/NOVORA ログイン統合時は novora_player_id を上書きするだけ
// ============================================================
const _ID_CHARS_LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';

function getPlayerId() {
  let id = localStorage.getItem(STORAGE_KEYS.PLAYER_ID);
  if (!id) {
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(12)),
      b => _ID_CHARS_LOWER[b % _ID_CHARS_LOWER.length]).join('');
    id = `guest_${rand}`;
    localStorage.setItem(STORAGE_KEYS.PLAYER_ID, id);
  }
  return id;
}

// ── 表示名（ランキングに載る名前・日本語可・最大15文字） ──
const DISPLAY_NAME_MAX = 15;

const _GUEST_PREFIX = { ja: 'ゲスト_', en: 'guest_', zh: '访客_' };

function getDisplayName() {
  let name = localStorage.getItem(STORAGE_KEYS.DISPLAY_NAME);
  if (!name) {
    // 初回: 言語に合わせたプレフィックス + player_id サフィックス先頭6文字
    const pid    = getPlayerId();
    const suffix = pid.includes('_') ? pid.split('_').slice(1).join('').slice(0, 6) : pid.slice(0, 6);
    const prefix = _GUEST_PREFIX[typeof currentLang !== 'undefined' ? currentLang : 'en'] ?? 'guest_';
    name = prefix + suffix;
    localStorage.setItem(STORAGE_KEYS.DISPLAY_NAME, name);
  }
  return name;
}

function saveDisplayName(rawName) {
  const name = rawName.replace(/[<>"&]/g, '').trim().slice(0, DISPLAY_NAME_MAX);
  if (name.length === 0) return false;
  localStorage.setItem(STORAGE_KEYS.DISPLAY_NAME, name);
  localStorage.setItem(STORAGE_KEYS.NAME_SET, '1');
  return true;
}

// 表示名をサーバーの players テーブルに即時同期
// ゲームプレイ時は share POST で自動 upsert されるが、
// 設定・プロフィールページでの変更はこちらで明示的に送信する
async function syncDisplayNameToServer() {
  try {
    await fetch('/api/rollaxy/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: getPlayerId(), display_name: getDisplayName() }),
    });
  } catch (_) {}
}

// ゲストコード（player_id のサフィックス部分を表示用に取り出す）
function getGuestCode() {
  const pid = getPlayerId();
  return pid.includes('_') ? pid.split('_').slice(1).join('') : pid;
}

// 自分のシェアID一覧を localStorage に追記（最大50件）
// ベスト更新時は best_share_id / best_score をモード別に更新。
// currentScore は「送信スコア」: speedrun は 10_000_000 - ms（大きいほど速い）。
function addMyShareId(shareId, currentScore, mode = 'endless') {
  const ids = JSON.parse(localStorage.getItem(STORAGE_KEYS.SHARE_IDS) || '[]');
  if (!ids.includes(shareId)) ids.push(shareId);
  localStorage.setItem(STORAGE_KEYS.SHARE_IDS, JSON.stringify(ids.slice(-50)));
  // モード別の best_score / best_share_id キーを選ぶ
  let bestKey, bestShareKey;
  if (mode === 'time') {
    bestKey = STORAGE_KEYS.BEST_SCORE_TIME; bestShareKey = STORAGE_KEYS.BEST_SHARE_ID_TIME;
  } else if (mode === 'speedrun') {
    // speedrun のベストタイムは BEST_SPEEDRUN_MS(ms) が真。ここではシェアID のみ更新。
    bestShareKey = STORAGE_KEYS.BEST_SHARE_ID_SPEEDRUN;
    bestKey = null;
  } else {
    bestKey = STORAGE_KEYS.BEST_SCORE; bestShareKey = STORAGE_KEYS.BEST_SHARE_ID;
  }
  if (mode === 'speedrun') {
    // ベストタイム(ms)が小さいほど良い。今回がベスト以下なら share_id を更新。
    const bestMs   = Number(localStorage.getItem(STORAGE_KEYS.BEST_SPEEDRUN_MS) || 0);
    const currentMs = 10_000_000 - currentScore;
    if (!bestMs || currentMs <= bestMs) {
      localStorage.setItem(bestShareKey, shareId);
    }
    return;
  }
  const best = Number(localStorage.getItem(bestKey) || 0);
  if (currentScore >= best) {
    localStorage.setItem(bestKey,      String(currentScore));
    localStorage.setItem(bestShareKey, shareId);
  }
}
