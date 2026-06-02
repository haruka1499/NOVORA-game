'use strict';

// ============================================================
// SHARE — シェアページ投稿・X（Twitter）シェア
// ============================================================
const shareBtn = document.getElementById('share-btn');

function _restoreShareButton() {
  shareBtn.disabled = false;
  shareBtn.textContent = T('shareBtn');
  shareBtn.classList.remove('loading');
}

// 盤面スナップショットを Worker に POST して共有 URL を取得する（失敗しても UI に影響しない）
// 設計方針:
//   1. share POST が成功したら即座にシェアボタンを有効化（UXを最優先）
//   2. OGP 画像はバックグラウンドで生成・KVキャッシュに保存（fire-and-forget）
//      Twitter クローラーはシェアから数十秒後に来るため、OGP 生成は十分間に合う。
//      await すると有料プランでも resvg(WASM) の処理時間によってボタン有効化が遅延する。
async function _createShare() {
  const controller  = new AbortController();
  const timeoutId   = setTimeout(() => controller.abort(), 10000);
  // await 前に同期収集（_startGameOverAnim() が非同期で bmap を消していく前に取得）
  const elapsed_ms  = Date.now() - _gameStartTime;
  const drop_count  = _dropCount;
  let highestTier = 0;
  const bodies = [];
  for (const d of bmap.values()) {
    if (d.bi > highestTier) highestTier = d.bi;
    bodies.push({
      tier:  d.bi,
      x:     Math.round(d.body.position.x * 10) / 10,
      y:     Math.round(d.body.position.y * 10) / 10,
      angle: Math.round(d.body.angle * 100) / 100,
    });
  }
  // speedrun クリア時は score 欄を「10_000_000 - 経過ms」に変換 (小さい ms = 大きい score = 上位)
  const _modeType = (typeof curMode === 'function' && curMode()) ? curMode().type : null;
  const _isSpeedrunClear = (_modeType === 'speedrun' && typeof _speedrunCleared !== 'undefined' && _speedrunCleared);
  const submitScore = _isSpeedrunClear
    ? Math.max(1, 10_000_000 - Math.min(_speedrunClearMs, 9_999_999))
    : score;
  const shareScore = submitScore; // クロージャ保持（addMyShareId 用）
  try {
    const res = await fetch('/api/rollaxy/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: submitScore,
        mode:              typeof currentModeId !== 'undefined' ? currentModeId : 'endless',
        highest_body_tier: highestTier,
        snapshot_payload:  {
          bodies,
          // replay / anti-cheat metadata（将来の server-side validation 用）
          elapsed_ms,
          drop_count,
          body_count: bodies.length,
        },
        ui_lang:       typeof currentLang !== 'undefined' ? currentLang : 'ja',
        // セーブ再開由来か（将来のチート対策/区別用。現状サーバーは未保存）
        resumed:       (typeof _resumedFromSave !== 'undefined' && _resumedFromSave) ? 1 : 0,
        version:       CFG.GAME_VERSION,
        player_id:     getPlayerId(),    // guest_xxx 形式（将来ログイン統合時は差し替え）
        display_name:  getDisplayName(), // ランキングに表示する表示名
        session_token: typeof _sessionToken !== 'undefined' ? _sessionToken : null,
      }),
      signal: controller.signal,
    });
    if (res.ok) {
      const { id, rank, total, periods } = await res.json();
      _pendingShareId = id;
      const _shareMode = typeof currentModeId !== 'undefined' ? currentModeId : 'endless';
      addMyShareId(id, shareScore, _shareMode); // share_ids / best_share_id を localStorage に記録
      // OGP 画像をバックグラウンドで生成（fire-and-forget）
      fetch(`/games/rollaxy/ogp/${id}`).catch(() => {});
      // ランクキャッシュを無効化して再フェッチ → ホーム画面の順位を最新化
      if (typeof _motivRankCache !== 'undefined') _motivRankCache = null;
      if (typeof _motivFetchRankings === 'function' && typeof _renderMyStats === 'function') {
        _motivFetchRankings().then(() => _renderMyStats()).catch(() => {});
      }
      // 上位%を計算してゲームオーバー画面に表示（今週ベース）
      if (periods && typeof periods === 'object' && periods.week) {
        const { rank, total } = periods.week;
        if (total > 0) {
          const raw    = rank / total * 100;
          const pct    = Math.min(99.9, Math.max(0.1, Math.round(raw * 10) / 10));
          const pctStr = pct % 1 === 0 ? pct.toFixed(1) : String(pct);
          const pctEl  = document.getElementById('rank-pct-el');
          if (pctEl) {
            pctEl.textContent = T('rankPct')(pctStr);
            show(pctEl);
          }
        }
      }
    } else {
      // 400/429 などのエラー内容をコンソールに出力してデバッグしやすくする
      try {
        const errBody = await res.json();
        console.warn('[share] rejected by server:', res.status, errBody,
          { score, highest_body_tier: highestTier, elapsed_ms, drop_count });
      } catch (_) {
        console.warn('[share] rejected by server:', res.status,
          { score, highest_body_tier: highestTier, elapsed_ms, drop_count });
      }
    }
  } catch (err) {
    // タイムアウト・ネットワークエラー等 → フォールバックURLでシェア可能
    console.warn('[share] network error:', err);
  } finally {
    clearTimeout(timeoutId);
    _restoreShareButton();
  }
}

// ============================================================
// X（Twitter）シェア
// canvas.toDataURL()（同期）でキャプチャし、非同期処理を一切挟まないことで
// ポップアップブロッカーを回避する。
// ① Twitter Intent を先に開く（ユーザー操作直後の最初のアクション）
// ② 盤面画像をダウンロード（ツイートに手動添付できるよう）
// 定型文は lang.js の tweetText、URL は CFG.SHARE.URL で変更可能。
// ============================================================

// data URL → Blob 同期変換（ユーザージェスチャーコンテキストを保つため同期で行う）
function _dataURLtoBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function shareToX() {
  // disabled 状態（シェアID取得中）はタッチイベント経由でも実行しない。
  // 一部ブラウザでは disabled ボタンでも touchend が発火するため明示ガードが必要。
  if (shareBtn.disabled) return;

  logEvent('share_click', {
    game_id:       'rollaxy',
    score,
    has_share_url: _pendingShareId ? 1 : 0, // OGP付きURLが発行済みか
  });
  const text    = T('tweetText')(score);
  // 共有 URL: 個別シェアページ（生成済み）> ゲームトップページ > なし
  // サーバー側で OGP 画像を生成するので canvas スクショは不要
  const shareId  = _pendingShareId;
  const shareUrl = shareId
    ? `${CFG.SHARE.URL.replace(/\/$/, '')}/share/${shareId}`
    : (CFG.SHARE.URL || '');

  const tweetUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text)
    + (shareUrl ? '&url=' + encodeURIComponent(shareUrl) : '');
  window.open(tweetUrl, '_blank');
}

on(shareBtn, () => shareToX());
