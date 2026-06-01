// ============================================================
// NOVORA GAME — Cloudflare Worker
// 静的アセット配信 (env.ASSETS) + 動的 API ルートをここで処理する
// ============================================================
import {
  GAME_ID, SITE_URL, MIN_SCORE_FOR_TIER,
  BODY_EMOJIS, BODY_COLORS, BODY_RADII, BODY_KEYS, BODY_IMAGE_ADJUST,
  getTitle, getTitleI18n, scoreWithComma,
} from './constants.js';
import { handleOgp } from './ogp.js';
import { signJwt, verifyJwt } from './auth.js';

// ============================================================
// CORS ヘルパー
// ============================================================
const ALLOWED_ORIGIN = 'https://novoragame.com';

function corsHeaders(origin) {
  const allowed = (origin === ALLOWED_ORIGIN || origin === 'https://staging.novoragame.com')
    ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ============================================================
// レートリミット（KV を使った IP ベース制限）
// share API に対して 10 回/分/IP を超えたらブロック。
// KV エラー時は通す（可用性優先）。
// ============================================================
async function _rateLimit(env, ip) {
  const key = `rl:share:${ip}`;
  try {
    const cur = parseInt(await env.RANKING_CACHE.get(key) || '0', 10);
    if (cur >= 10) return false;
    await env.RANKING_CACHE.put(key, String(cur + 1), { expirationTtl: 60 });
    return true;
  } catch { return true; }
}

// ============================================================
// nanoid (10文字)
// ============================================================
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function nanoid() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => ID_CHARS[b % ID_CHARS.length]).join('');
}

// ============================================================
// POST /api/rollaxy/share — 盤面保存
// ============================================================
async function handleSharePost(request, env) {
  const origin = request.headers.get('Origin') ?? '';

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, corsHeaders(origin)); }

  const { score, highest_body_tier, snapshot_payload, ui_lang = 'ja', version = 1, player_id = null, display_name = null, mode: rawMode = 'endless' } = body;
  // 許可モード: endless / time / speedrun（未知値は endless にフォールバック）
  const VALID_MODES = ['endless', 'time', 'speedrun'];
  const mode = VALID_MODES.includes(rawMode) ? rawMode : 'endless';

  // ── 基本バリデーション ──
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 999999) {
    console.warn(`[share] rejected: invalid score=${score}`);
    return json({ error: 'invalid score' }, 400, corsHeaders(origin));
  }
  if (typeof highest_body_tier !== 'number' || !Number.isInteger(highest_body_tier)
      || highest_body_tier < 0 || highest_body_tier > 11) {
    console.warn(`[share] rejected: invalid tier=${highest_body_tier}`);
    return json({ error: 'invalid tier' }, 400, corsHeaders(origin));
  }
  if (!snapshot_payload) {
    console.warn(`[share] rejected: missing snapshot_payload`);
    return json({ error: 'Missing required fields' }, 400, corsHeaders(origin));
  }
  if (score < MIN_SCORE_FOR_TIER[highest_body_tier]) {
    console.warn(`[share] rejected: score/tier mismatch score=${score} tier=${highest_body_tier} min=${MIN_SCORE_FOR_TIER[highest_body_tier]}`);
    return json({ error: 'score/tier mismatch' }, 400, corsHeaders(origin));
  }

  // ── レートリミット（IP 単位 10回/分）──
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await _rateLimit(env, ip))) {
    console.warn(`[share] rejected: rate limit ip=${ip}`);
    return json({ error: 'rate limit exceeded' }, 429, corsHeaders(origin));
  }

  // ── セッショントークン検証 ──
  // 現在は未強制。アカウントシステム追加時に有効化する。
  // インフラ（auth.js・/api/session・クライアント側送信）は維持済み。
  // if (env.JWT_SECRET) {
  //   const tok     = typeof body.session_token === 'string' ? body.session_token : null;
  //   const payload = tok ? await verifyJwt(tok, env.JWT_SECRET) : null;
  //   if (!payload || payload.gid !== GAME_ID) {
  //     return json({ error: 'invalid session' }, 401, corsHeaders(origin));
  //   }
  // }

  // ── スコア整合チェック ──
  // elapsed_ms / drop_count で明らかに異常なスコアを弾く。
  // 正常プレイなら 1 ドロップあたり最低 200ms・最大 1000 点程度が上限。
  const { drop_count, elapsed_ms } = snapshot_payload;
  if (typeof drop_count === 'number' && typeof elapsed_ms === 'number' && drop_count > 0) {
    if (elapsed_ms < drop_count * 200) {
      console.warn(`[share] rejected: too fast elapsed_ms=${elapsed_ms} drop_count=${drop_count}`);
      return json({ error: 'invalid play data' }, 400, corsHeaders(origin));
    }
    if (score / drop_count > 1000) {
      console.warn(`[share] rejected: score/drop ratio score=${score} drop_count=${drop_count}`);
      return json({ error: 'invalid play data' }, 400, corsHeaders(origin));
    }
  }

  // ── player_id バリデーション ──
  // フォーマット: {provider}_{8〜28文字英数字} 例: guest_a3f8kz9mxqbt
  const pid = (typeof player_id === 'string' && /^[a-z]+_[a-z0-9]{8,28}$/.test(player_id))
    ? player_id : null;

  // ── display_name バリデーション ──
  const dname = (typeof display_name === 'string' && display_name.trim().length >= 1)
    ? display_name.trim().replace(/[<>"&]/g, '').slice(0, 15) || null
    : null;

  const id         = nanoid();
  const created_at = Math.floor(Date.now() / 1000);
  const payload    = JSON.stringify(snapshot_payload);

  // shares への INSERT（player_id / display_name 列が未追加の場合はフォールバック）
  try {
    await env.DB.prepare(
      `INSERT INTO shares (id, game_id, version, score, highest_body_tier, snapshot_payload, ui_lang, created_at, retention_type, player_id, display_name, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?, ?)`
    ).bind(id, GAME_ID, version, score, highest_body_tier, payload, ui_lang, created_at, pid, dname, mode).run();
  } catch (_) {
    await env.DB.prepare(
      `INSERT INTO shares (id, game_id, version, score, highest_body_tier, snapshot_payload, ui_lang, created_at, retention_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal')`
    ).bind(id, GAME_ID, version, score, highest_body_tier, payload, ui_lang, created_at).run();
  }

  // players テーブルへ upsert（最新の表示名を常に最新に保つ）
  if (pid) {
    const pname = dname ?? ('ゲスト_' + pid.split('_').slice(1).join('').slice(0, 6));
    try {
      await env.DB.prepare(
        `INSERT INTO players (player_id, display_name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           display_name = excluded.display_name,
           updated_at   = excluded.updated_at`
      ).bind(pid, pname, created_at).run();
    } catch (_) {} // players テーブル未作成の場合は無視
  }

  // ランキング retention 再計算
  const keepRow = await env.DB.prepare(`SELECT value FROM config WHERE key='keep_top_n'`).first();
  const keepN   = keepRow ? parseInt(keepRow.value, 10) : 1000;
  await env.DB.prepare(
    `UPDATE shares SET retention_type='normal' WHERE game_id=? AND retention_type='ranked'`
  ).bind(GAME_ID).run();
  await env.DB.prepare(
    `UPDATE shares SET retention_type='ranked'
     WHERE game_id=? AND id IN (SELECT id FROM shares WHERE game_id=? ORDER BY score DESC LIMIT ?)`
  ).bind(GAME_ID, GAME_ID, keepN).run();

  try { await env.RANKING_CACHE.delete('all'); } catch (_) {}

  // ── 今日・今週・全期間の順位/総数を並列取得（ゲームオーバー画面での上位%表示用）──
  // share POST には timezone 情報がないため、ローリングウィンドウで近似する。
  //   today: 直近 24h  / week: 直近 7日 / all: 全期間
  let periods = null;
  try {
    const now      = Math.floor(Date.now() / 1000);
    const day1ago  = now - 86400;
    const day7ago  = now - 86400 * 7;
    const [
      allRank, allTotal,
      dayRank, dayTotal,
      wkRank,  wkTotal,
    ] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM shares WHERE game_id=? AND score>?          AND COALESCE(mode,'endless')=?`).bind(GAME_ID, score,   mode).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM shares WHERE game_id=?                      AND COALESCE(mode,'endless')=?`).bind(GAME_ID,         mode).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM shares WHERE game_id=? AND score>? AND created_at>=? AND COALESCE(mode,'endless')=?`).bind(GAME_ID, score, day1ago, mode).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM shares WHERE game_id=? AND created_at>=?    AND COALESCE(mode,'endless')=?`).bind(GAME_ID, day1ago, mode).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM shares WHERE game_id=? AND score>? AND created_at>=? AND COALESCE(mode,'endless')=?`).bind(GAME_ID, score, day7ago, mode).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM shares WHERE game_id=? AND created_at>=?    AND COALESCE(mode,'endless')=?`).bind(GAME_ID, day7ago, mode).first(),
    ]);
    periods = {
      all:   { rank: (allRank?.cnt ?? 0) + 1, total: Math.max(allTotal?.cnt ?? 1, 1) },
      today: { rank: (dayRank?.cnt ?? 0) + 1, total: Math.max(dayTotal?.cnt ?? 1, 1) },
      week:  { rank: (wkRank?.cnt  ?? 0) + 1, total: Math.max(wkTotal?.cnt  ?? 1, 1) },
    };
  } catch (_) {}

  return json(
    { id, url: `${SITE_URL}/games/rollaxy/share/${id}`, periods },
    201,
    corsHeaders(origin)
  );
}

// ============================================================
// GET /api/rollaxy/ranking — ランキング取得
// ============================================================
const CACHE_TTL = 60;
const MAX_LIMIT = 100;
const DEF_LIMIT = 20;

async function handleRanking(request, env) {
  const url    = new URL(request.url);
  const period = url.searchParams.get('period') ?? 'all';
  const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? DEF_LIMIT, 10), MAX_LIMIT);
  const _rawMode = url.searchParams.get('mode');
  const mode   = (_rawMode === 'time' || _rawMode === 'speedrun') ? _rawMode : 'endless';

  // tz: クライアントのUTCオフセット（分）。例: JST=+540、EST=-300
  // -(new Date().getTimezoneOffset()) で取得した値をそのまま渡す。
  // 未指定・不正値はUTC(0)にフォールバック。有効範囲: -720〜840
  const tzRaw = parseInt(url.searchParams.get('tz') ?? '0', 10);
  const tz    = (Number.isFinite(tzRaw) && tzRaw >= -720 && tzRaw <= 840) ? tzRaw : 0;

  if (!['all', 'daily', 'weekly'].includes(period)) {
    return json({ error: 'period must be all | daily | weekly' }, 400);
  }

  // all と weekly はタイムゾーン無関係（ローリングウィンドウ）。daily のみ tz 別キャッシュ。
  const cacheKey = (period === 'all' || period === 'weekly')
    ? `${GAME_ID}:ranking:${mode}:${period}:${limit}`
    : `${GAME_ID}:ranking:${mode}:${period}:${limit}:tz${tz}`;
  try {
    const cached = await env.RANKING_CACHE.get(cacheKey, 'json');
    if (cached) return json(cached, 200, { 'X-Cache': 'HIT' });
  } catch (_) {}

  const now   = Math.floor(Date.now() / 1000);
  // ── 期間境界計算 (すべてローリングウィンドウ) ──
  // daily : 直近 24 時間
  // weekly: 直近 7 日 (カレンダー週ではない。月曜区切りを廃止)
  // all   : 制限なし
  let since;
  if (period === 'all') {
    since = 0;
  } else if (period === 'daily') {
    since = now - 86400;
  } else {
    since = now - 7 * 86400; // 直近 7 日（604800 秒）
  }

  // ── ランキング取得（プレイヤーごとにベストスコアのみ表示） ──
  // ROW_NUMBER() で player_id 単位のベスト1件に絞る。
  // player_id IS NULL の旧データはランキングから除外（データ自体は保持）。
  // タイスコアは最新のレコードを優先（created_at DESC）。
  // フォールバック: players テーブルなし → shares.display_name → 列なし の順で試みる
  let results;
  try {
    ({ results } = await env.DB.prepare(
      `SELECT id, score, highest_body_tier, created_at, display_name
       FROM (
         SELECT s.id, s.score, s.highest_body_tier, s.created_at,
                COALESCE(p.display_name, s.display_name) AS display_name,
                ROW_NUMBER() OVER (
                  PARTITION BY s.player_id
                  ORDER BY s.score DESC, s.created_at DESC
                ) AS rn
         FROM shares s
         LEFT JOIN players p ON s.player_id = p.player_id
         WHERE s.game_id=? AND s.created_at>=? AND s.player_id IS NOT NULL
           AND COALESCE(s.mode,'endless')=?
       )
       WHERE rn=1
       ORDER BY score DESC LIMIT ?`
    ).bind(GAME_ID, since, mode, limit).all());
  } catch (_) {
    try {
      ({ results } = await env.DB.prepare(
        `SELECT id, score, highest_body_tier, created_at, display_name
         FROM (
           SELECT id, score, highest_body_tier, created_at, display_name,
                  ROW_NUMBER() OVER (
                    PARTITION BY player_id
                    ORDER BY score DESC, created_at DESC
                  ) AS rn
           FROM shares
           WHERE game_id=? AND created_at>=? AND player_id IS NOT NULL
             AND COALESCE(mode,'endless')=?
         )
         WHERE rn=1
         ORDER BY score DESC LIMIT ?`
      ).bind(GAME_ID, since, mode, limit).all());
    } catch (_) {
      try {
        ({ results } = await env.DB.prepare(
          `SELECT id, score, highest_body_tier, created_at
           FROM (
             SELECT id, score, highest_body_tier, created_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY player_id
                      ORDER BY score DESC, created_at DESC
                    ) AS rn
             FROM shares
             WHERE game_id=? AND created_at>=? AND player_id IS NOT NULL
               AND COALESCE(mode,'endless')=?
           )
           WHERE rn=1
           ORDER BY score DESC LIMIT ?`
        ).bind(GAME_ID, since, mode, limit).all());
      } catch (_) {
        // mode列未追加(migration未実施)の場合の最終フォールバック。modeフィルターなし。
        ({ results } = await env.DB.prepare(
          `SELECT id, score, highest_body_tier, created_at, display_name
           FROM (
             SELECT id, score, highest_body_tier, created_at, display_name,
                    ROW_NUMBER() OVER (
                      PARTITION BY player_id
                      ORDER BY score DESC, created_at DESC
                    ) AS rn
             FROM shares
             WHERE game_id=? AND created_at>=? AND player_id IS NOT NULL
           )
           WHERE rn=1
           ORDER BY score DESC LIMIT ?`
        ).bind(GAME_ID, since, limit).all());
      }
    }
  }

  const entries = results.map((row, i) => ({
    rank:              i + 1,
    score:             row.score,
    highest_body_tier: row.highest_body_tier,
    id:                row.id,
    created_at:        row.created_at,
    display_name:      row.display_name || null,
  }));

  const payload = { period, updated_at: now, entries };
  try {
    await env.RANKING_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL });
  } catch (_) {}

  return json(payload, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL}` });
}

// ============================================================
// POST /api/admin/clear-ogp-cache — OGP KVキャッシュ一括削除（要認証）
// KV の "ogp:" プレフィックスを持つキーをすべて削除する。
// ============================================================
async function handleClearOgpCache(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!env.ADMIN_SECRET || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let deleted = 0;
  let cursor  = undefined;

  // KV list は最大1000件/回なのでカーソルでページネーション
  while (true) {
    const listRes = await env.RANKING_CACHE.list({ prefix: 'ogp:', limit: 1000, cursor });
    const keys = listRes.keys.map(k => k.name);
    await Promise.all(keys.map(k => env.RANKING_CACHE.delete(k)));
    deleted += keys.length;
    if (listRes.list_complete) break;
    cursor = listRes.cursor;
  }

  return json({ ok: true, deleted });
}

// ============================================================
// POST /api/admin/cleanup — 手動クリーンアップ（要認証）
// ============================================================
async function handleCleanup(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!env.ADMIN_SECRET || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const cfgRows = await env.DB.prepare(`SELECT key, value FROM config`).all();
  const cfg     = Object.fromEntries(cfgRows.results.map(r => [r.key, parseInt(r.value, 10)]));
  const maxShares = cfg.max_shares         ?? 20000;
  const keepTopN  = cfg.keep_top_n         ?? 1000;
  const batchSize = cfg.cleanup_batch_size ?? 500;

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM shares WHERE game_id=?`
  ).bind(GAME_ID).first();
  const total = countRow?.cnt ?? 0;

  let deleted = 0;
  if (total > maxShares) {
    // player_id を持つプレイヤーのベストスコアは削除しない。
    // 条件: player_id が NULL（匿名）か、そのプレイヤーの最高スコアより低いレコードのみ削除。
    // → 識別済みプレイヤーが何十回プレイしても、ベストスコアのシェアだけは残る。
    const del = await env.DB.prepare(
      `DELETE FROM shares
       WHERE game_id=? AND retention_type='normal'
       AND id IN (
         SELECT id FROM shares
         WHERE game_id=? AND retention_type='normal'
         ORDER BY created_at ASC LIMIT ?
       )
       AND (
         player_id IS NULL
         OR score < (
           SELECT MAX(s2.score) FROM shares s2
           WHERE s2.game_id=? AND s2.player_id = shares.player_id
         )
       )`
    ).bind(GAME_ID, GAME_ID, batchSize, GAME_ID).run();
    deleted = del.meta?.changes ?? 0;
  }

  await env.DB.prepare(
    `UPDATE shares SET retention_type='normal' WHERE game_id=? AND retention_type='ranked'`
  ).bind(GAME_ID).run();
  await env.DB.prepare(
    `UPDATE shares SET retention_type='ranked'
     WHERE game_id=? AND id IN (SELECT id FROM shares WHERE game_id=? ORDER BY score DESC LIMIT ?)`
  ).bind(GAME_ID, GAME_ID, keepTopN).run();

  let kvCleared = 0;
  for (const period of ['all', 'daily', 'weekly']) {
    for (const lim of [20, 50, 100]) {
      try { await env.RANKING_CACHE.delete(`${GAME_ID}:ranking:${period}:${lim}`); kvCleared++; }
      catch (_) {}
    }
  }

  return json({ ok: true, total_before: total, deleted, kv_cleared: kvCleared });
}

// ============================================================
// シェアページ多言語テキスト
// ============================================================
const _SL = {
  ja: {
    rankText:       rank => `全体 ${rank.toLocaleString('en-US')} 位`,
    playBtn:        'Rollaxy をプレイ',
    tweetBtn:       'X でシェア',
    gamesLink:      'ゲーム一覧',
    backToRanking:  '← ランキングに戻る',
    tweetText: (score, title) => `スコア ${score} — ${title}！`,
    desc:      (score, title, emoji) => `${title} — スコア ${score}、最大天体 ${emoji}。あなたも挑戦！`,
    navGames: 'ゲーム', navAbout: 'About', navPrivacy: 'Privacy',
    footerHome: 'Home', footerGames: 'ゲーム', footerPrivacy: 'プライバシーポリシー',
  },
  en: {
    rankText:       rank => `Overall Rank #${rank.toLocaleString('en-US')}`,
    playBtn:        'Play Rollaxy',
    tweetBtn:       'Share on X',
    gamesLink:      'Game List',
    backToRanking:  '← Back to Ranking',
    tweetText: (score, title) => `Score ${score} — ${title}!`,
    desc:      (score, title, emoji) => `${title} — Score ${score}, top body ${emoji}. Try it!`,
    navGames: 'Games', navAbout: 'About', navPrivacy: 'Privacy',
    footerHome: 'Home', footerGames: 'Games', footerPrivacy: 'Privacy Policy',
  },
  zh: {
    rankText:       rank => `全球排名第 ${rank.toLocaleString('en-US')} 名`,
    playBtn:        '开始游戏',
    tweetBtn:       '分享到 X',
    gamesLink:      '游戏列表',
    backToRanking:  '← 返回排行榜',
    tweetText: (score, title) => `得分 ${score} — ${title}！`,
    desc:      (score, title, emoji) => `${title} — 得分 ${score}，最大天体 ${emoji}。快来挑战！`,
    navGames: '游戏', navAbout: 'About', navPrivacy: 'Privacy',
    footerHome: 'Home', footerGames: '游戏', footerPrivacy: '隐私政策',
  },
};

// ============================================================
// GET /games/rollaxy/share/:id — シェアページ HTML
// ============================================================
function buildBoardSVG(bodies) {
  const SCALE = 0.5;
  // ゲームボード領域（新レイアウト座標。config.js の BOX と一致させること）
  const BOX_L = 18, BOX_T = 240, BOX_R = 382, BOX_B = 760;
  const M = 18; // 盤面外周の余白（ゲーム座標）
  // viewBox を盤面領域＋余白に合わせて切り抜く（天体は絶対座標で描画される）
  const vx = ((BOX_L - M) * SCALE);
  const vy = ((BOX_T - M) * SCALE);
  const vw = ((BOX_R - BOX_L + 2 * M) * SCALE);
  const vh = ((BOX_B - BOX_T + 2 * M) * SCALE);
  let defs = '<defs>', circles = '', images = '';
  for (let i = 0; i < bodies.length; i++) {
    const b    = bodies[i];
    const tier = Math.max(0, Math.min(11, b.tier));
    const cx = (b.x * SCALE).toFixed(1);
    const cy = (b.y * SCALE).toFixed(1);
    const r  = (BODY_RADII[tier] * SCALE).toFixed(1);
    const rn   = BODY_RADII[tier] * SCALE;
    const iadj = BODY_IMAGE_ADJUST[tier];
    const imgRn = rn * iadj.scale;
    const lx = (b.x * SCALE - imgRn + rn * iadj.dx).toFixed(1);
    const ly = (b.y * SCALE - imgRn + rn * iadj.dy).toFixed(1);
    const d  = (imgRn * 2).toFixed(1);
    // b.angle は Matter.js のラジアン値。旧データ（angle未記録）は 0 扱い
    const angleDeg = ((b.angle ?? 0) * 180 / Math.PI).toFixed(2);
    // ① ベース円（画像ロード失敗時のフォールバック）
    circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BODY_COLORS[tier]}" opacity="0.85"/>`;
    // ② 実際のゲーム画像をクリップして円形に貼る（ブラウザが PNG を直接読み込む）
    // <g> に clip-path + transform を同時付与することで、offset/scale 済み画像を
    // 円の中心 (cx,cy) を軸に回転させる（clip-path は親座標系で固定されるため位置ずれなし）
    defs   += `<clipPath id="c${i}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>`;
    images += `<g clip-path="url(#c${i})" transform="rotate(${angleDeg},${cx},${cy})"><image href="/games/rollaxy/images/${BODY_KEYS[tier]}.png" x="${lx}" y="${ly}" width="${d}" height="${d}" preserveAspectRatio="xMidYMid slice"/></g>`;
  }
  defs += '</defs>';
  const bx = (BOX_L * SCALE).toFixed(1), by = (BOX_T * SCALE).toFixed(1);
  const bw = ((BOX_R - BOX_L) * SCALE).toFixed(1), bh = ((BOX_B - BOX_T) * SCALE).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${vw.toFixed(1)}" height="${vh.toFixed(1)}" viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}">
  ${defs}
  <rect x="${vx.toFixed(1)}" y="${vy.toFixed(1)}" width="${vw.toFixed(1)}" height="${vh.toFixed(1)}" fill="#060412"/>
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#0c0720"/>
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="#7744bb" stroke-width="1.5"/>
  ${circles}${images}</svg>`;
}

async function handleSharePage(id, env) {
  const row = await env.DB.prepare(
    `SELECT id, score, highest_body_tier, snapshot_payload, ui_lang FROM shares WHERE id=?`
  ).bind(id).first();
  if (!row) return sharePage404();

  const lang = (_SL[row.ui_lang] ? row.ui_lang : 'ja');
  const L    = _SL[lang];

  const rankRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM shares WHERE game_id='rollaxy' AND score>?`
  ).bind(row.score).first();
  const rank     = (rankRow?.cnt ?? 0) + 1;
  const rankText = L.rankText(rank);

  let bodies = [];
  try { bodies = JSON.parse(row.snapshot_payload).bodies ?? []; } catch (_) {}

  const titleStr  = getTitleI18n(row.score, row.highest_body_tier, lang);
  const maxEmoji  = BODY_EMOJIS[Math.min(11, row.highest_body_tier)];
  const svg       = buildBoardSVG(bodies);
  const scoreStr  = scoreWithComma(row.score);
  const shareUrl  = `${SITE_URL}/games/rollaxy/share/${id}`;
  const ogImage   = `${SITE_URL}/games/rollaxy/ogp/${id}`;
  const pageTitle = `Score ${scoreStr} | Rollaxy | NOVORA GAME`;
  const desc      = L.desc(scoreStr, titleStr, maxEmoji);
  const htmlLang  = lang === 'zh' ? 'zh' : lang === 'en' ? 'en' : 'ja';

  const html = `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-FFF4H3EVV8"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-FFF4H3EVV8');</script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <meta name="description" content="${desc}">
  <meta name="robots" content="noindex">
  <link rel="canonical" href="${shareUrl}">
  <link rel="icon" href="/favicon.ico">
  <meta property="og:type"         content="website">
  <meta property="og:url"          content="${shareUrl}">
  <meta property="og:title"        content="${pageTitle}">
  <meta property="og:description"  content="${desc}">
  <meta property="og:image"        content="${ogImage}">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${pageTitle}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image"       content="${ogImage}">
  <link rel="stylesheet" href="/style.css">
  <style>
    .share-page{max-width:480px;margin:0 auto;padding:24px 16px 48px;text-align:center}
    .share-board{display:inline-block;margin:24px auto;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(119,68,204,.4)}
    .share-board svg{display:block}
    .share-score{font-size:2.4rem;font-weight:700;color:#fff;margin:8px 0 4px}
    .share-title{font-size:1rem;color:#aa88ff;margin-bottom:4px}
    .share-rank{font-size:.85rem;color:#776699;margin-bottom:24px}
    .share-play{display:inline-block;padding:14px 40px;background:#7744cc;color:#fff;border-radius:8px;font-size:1.1rem;font-weight:700;text-decoration:none;margin-bottom:12px}
    .share-play:hover{background:#9966ee}
    .share-tweet{display:inline-block;padding:10px 28px;background:#000;color:#fff;border-radius:8px;font-size:.95rem;text-decoration:none;margin-left:8px}
    .share-tweet:hover{background:#222}
    .share-links{margin-top:16px;font-size:.85rem}
    .share-links a{color:#776699;margin:0 8px}
    .share-back{display:inline-block;padding:9px 22px;border:1px solid rgba(119,68,204,.5);border-radius:8px;color:#aa88ff;font-size:.9rem;text-decoration:none;cursor:pointer;background:transparent;margin-bottom:16px;transition:background .15s}
    .share-back:hover{background:rgba(119,68,204,.15)}
  </style>
</head>
<body>
<nav class="site-nav"><div class="nav-inner">
  <a href="/" class="nav-logo">NOVORA GAME</a>
  <ul class="nav-links">
    <li><a href="/games/">${L.navGames}</a></li>
    <li><a href="/about/">${L.navAbout}</a></li>
    <li><a href="/privacy/">${L.navPrivacy}</a></li>
  </ul>
</div></nav>
<main><div class="share-page">
  <button class="share-back" id="back-to-ranking-btn">${L.backToRanking}</button>
  <div class="share-board">${svg}</div>
  <div class="share-score">${scoreStr}</div>
  <div class="share-title">${titleStr} ${maxEmoji}</div>
  <div class="share-rank">${rankText}</div>
  <div>
    <a class="share-play" href="/games/rollaxy/">▶ ${L.playBtn}</a>
    <a id="share-tweet-btn" class="share-tweet" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(L.tweetText(scoreStr, titleStr))}&url=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener" style="display:none">${L.tweetBtn}</a>
  </div>
  <div class="share-links"><a href="/games/">${L.gamesLink}</a></div>
</div></main>
<script>
// ランキングから target="_blank" で開かれたタブなら window.close() でタブを閉じる。
// 直接URLアクセスの場合は window.close() が無視されるため、ランキングページへ遷移する。
document.getElementById('back-to-ranking-btn').addEventListener('click', function() {
  window.close();
  setTimeout(function() { location.href = '/games/rollaxy/ranking/'; }, 150);
});
// 自分のシェアIDの場合のみ X 共有ボタンを表示（他人のスコアを誤って共有できないように）
(function(){
  try {
    var ids = JSON.parse(localStorage.getItem('novora_share_ids') || '[]');
    if (ids.indexOf('${id}') >= 0) {
      var btn = document.getElementById('share-tweet-btn');
      if (btn) btn.style.display = '';
    }
  } catch(_) {}
})();
</script>
<footer class="site-footer">
  <div class="footer-links">
    <a href="/">${L.footerHome}</a><a href="/games/">${L.footerGames}</a><a href="/privacy/">${L.footerPrivacy}</a>
  </div>
  &copy; 2026 NOVORA GAME
</footer>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

function sharePage404() {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found</title></head>
<body style="font-family:sans-serif;text-align:center;padding:48px">
<h1>404</h1><p>このシェアページは存在しないか、削除されました。</p>
<a href="/games/rollaxy/">Rollaxy をプレイ</a></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// ============================================================
// GET /api/session — セッショントークン発行
// ゲーム開始時に呼ばれ、スコア投稿時の検証に使う JWT を返す。
// JWT_SECRET 未設定時は { token: null } を返し、後方互換を保つ。
// ============================================================
async function handleSession(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  if (!env.JWT_SECRET) {
    return json({ token: null }, 200, corsHeaders(origin));
  }
  const now   = Math.floor(Date.now() / 1000);
  const token = await signJwt({ iat: now, exp: now + 14400, gid: GAME_ID }, env.JWT_SECRET);
  return json({ token }, 200, corsHeaders(origin));
}

// ============================================================
// GET /api/rollaxy/achievements — 解除済み実績一覧取得
// ============================================================
async function handleAchievementsGet(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const pid    = new URL(request.url).searchParams.get('pid') ?? '';

  if (!/^[a-z]+_[a-z0-9]{8,28}$/.test(pid)) {
    return json({ error: 'invalid player_id' }, 400, corsHeaders(origin));
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT ach_id FROM achievements WHERE player_id = ?'
    ).bind(pid).all();
    return json({ ids: results.map(r => r.ach_id) }, 200, corsHeaders(origin));
  } catch (_) {
    // achievements テーブル未作成の場合は空配列を返して続行
    return json({ ids: [] }, 200, corsHeaders(origin));
  }
}

// ============================================================
// POST /api/rollaxy/achievements/unlock — 実績解除を記録
// ============================================================
async function handleAchievementsUnlock(request, env) {
  const origin = request.headers.get('Origin') ?? '';

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, corsHeaders(origin)); }

  const { player_id, ach_id } = body;

  const pid = (typeof player_id === 'string' && /^[a-z]+_[a-z0-9]{8,28}$/.test(player_id))
    ? player_id : null;
  if (!pid) return json({ error: 'invalid player_id' }, 400, corsHeaders(origin));

  // ach_id: 英小文字・数字・アンダースコアのみ、2〜50文字
  if (typeof ach_id !== 'string' || !/^[a-z][a-z0-9_]{1,49}$/.test(ach_id)) {
    return json({ error: 'invalid ach_id' }, 400, corsHeaders(origin));
  }

  // 1プレイヤーあたり上限200件（ストレージ保護）
  try {
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM achievements WHERE player_id = ?'
    ).bind(pid).first();
    if ((countRow?.cnt ?? 0) >= 200) {
      return json({ ok: true, skipped: true }, 200, corsHeaders(origin));
    }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO achievements (player_id, ach_id, unlocked_at) VALUES (?, ?, ?)'
    ).bind(pid, ach_id, Math.floor(Date.now() / 1000)).run();
    return json({ ok: true }, 200, corsHeaders(origin));
  } catch (_) {
    return json({ error: 'achievements table not ready' }, 503, corsHeaders(origin));
  }
}

// ============================================================
// POST /api/rollaxy/player — プレイヤー表示名の即時更新
// ============================================================
async function handlePlayerUpdate(request, env) {
  const origin = request.headers.get('Origin') ?? '';

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, corsHeaders(origin)); }

  const { player_id, display_name } = body;

  const pid = (typeof player_id === 'string' && /^[a-z]+_[a-z0-9]{8,28}$/.test(player_id))
    ? player_id : null;
  if (!pid) return json({ error: 'invalid player_id' }, 400, corsHeaders(origin));

  const dname = (typeof display_name === 'string' && display_name.trim().length >= 1)
    ? display_name.trim().replace(/[<>"&]/g, '').slice(0, 15) || null : null;
  if (!dname) return json({ error: 'invalid display_name' }, 400, corsHeaders(origin));

  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO players (player_id, display_name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at   = excluded.updated_at`
    ).bind(pid, dname, now).run();
  } catch (_) {
    return json({ error: 'players table not ready' }, 503, corsHeaders(origin));
  }

  // 名前変更が即座に反映されるよう、ranking キャッシュを無効化。
  // キー形式: ${GAME_ID}:ranking:${mode}:${period}:${limit} (all/weekly は tz 抜き)
  // daily は tz 別キーで件数が多いため、自然な TTL (60秒) 切れに任せる
  try {
    for (const mode of ['endless', 'time', 'speedrun']) {
      for (const p of ['all', 'weekly']) {
        for (const l of [20, 50, 100]) {
          await env.RANKING_CACHE.delete(`${GAME_ID}:ranking:${mode}:${p}:${l}`);
        }
      }
    }
  } catch (_) {}

  return json({ ok: true }, 200, corsHeaders(origin));
}

// ============================================================
// POST /api/rollaxy/report — クライアント異常レポート（簡易チート検知ログ）
// fire-and-forget。console.warn で Cloudflare ログ（wrangler tail / ダッシュボード）に出す。
// 永続化が必要になったら Logpush を設定する。本格的な enforcement は将来別途実装。
// ============================================================
async function handleReport(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  let body = {};
  try { body = await request.json(); } catch (_) {}

  const pid  = typeof body.player_id === 'string' ? body.player_id.slice(0, 40) : '?';
  const kind = typeof body.kind === 'string' ? body.kind.slice(0, 32) : '?';
  const cf   = request.cf || {};

  console.warn('[anticheat] ' + JSON.stringify({
    game:      GAME_ID,
    kind,                                   // 例: 'meta_sig_mismatch'
    player_id: pid,
    country:   cf.country || null,
    ip:        request.headers.get('CF-Connecting-IP') || null,
    ua:        (request.headers.get('User-Agent') || '').slice(0, 120),
    ts:        Date.now(),
  }));

  return json({ ok: true }, 200, corsHeaders(origin));
}

// ============================================================
// POST /api/rollaxy/feedback — ユーザーからのフィードバック投稿。
// Discord webhook (env.FEEDBACK_DISCORD_WEBHOOK) に embed 形式で転送。
// D1 保存はせず、流れたら見逃すリスクは許容（開発期フィードバック収集用）。
// レート制限: IP 5件/10分。
// ============================================================
async function _rateLimitFeedback(env, ip) {
  const key = `rl:feedback:${ip}`;
  try {
    const cur = parseInt(await env.RANKING_CACHE.get(key) || '0', 10);
    if (cur >= 5) return false;
    await env.RANKING_CACHE.put(key, String(cur + 1), { expirationTtl: 600 });
    return true;
  } catch { return true; }
}

async function handleFeedback(request, env) {
  const origin = request.headers.get('Origin') ?? '';

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, corsHeaders(origin)); }

  // 本文（必須・1〜1000 文字・サニタイズ）
  const rawText = typeof body.text === 'string' ? body.text.trim() : '';
  if (rawText.length < 1 || rawText.length > 1000) {
    return json({ error: 'invalid text length' }, 400, corsHeaders(origin));
  }
  const text = rawText.replace(/[<>"&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;',
  })[c]);

  // source
  const source = ['start', 'gameover', 'clear'].includes(body.source) ? body.source : 'unknown';

  // context（クライアント値を採用、サーバーで型だけ検証）
  const ctx = (body.context && typeof body.context === 'object') ? body.context : {};
  const pid = (typeof ctx.player_id === 'string' && /^[a-z]+_[a-z0-9]{8,28}$/.test(ctx.player_id))
    ? ctx.player_id : '?';
  const dname = (typeof ctx.display_name === 'string')
    ? ctx.display_name.trim().replace(/[<>"&]/g, '').slice(0, 15) : '';
  const score = (typeof ctx.score === 'number' && Number.isFinite(ctx.score)) ? ctx.score : null;
  const mode  = (typeof ctx.mode === 'string') ? ctx.mode.slice(0, 16) : '';
  const stage = (typeof ctx.stage_id === 'string') ? ctx.stage_id.slice(0, 16) : '';
  const lang  = (typeof ctx.lang === 'string') ? ctx.lang.slice(0, 8) : '';

  // レート制限
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await _rateLimitFeedback(env, ip))) {
    return json({ error: 'rate limit exceeded' }, 429, corsHeaders(origin));
  }

  // Discord webhook
  const webhook = env.FEEDBACK_DISCORD_WEBHOOK;
  if (!webhook) {
    console.warn('[feedback] FEEDBACK_DISCORD_WEBHOOK not configured');
    return json({ error: 'webhook not configured' }, 500, corsHeaders(origin));
  }

  const ua = (request.headers.get('User-Agent') || '').slice(0, 200);
  const country = (request.cf && request.cf.country) || '?';

  const embed = {
    title: `🎮 Rollaxy フィードバック (${source})`,
    description: text,
    color: 0x8fd6ff,
    fields: [
      { name: 'プレイヤー', value: `${dname || '匿名'} (${pid})`, inline: true },
      { name: 'モード / スコア', value: `${mode || '-'} / ${score ?? '-'}`, inline: true },
      { name: 'ステージ', value: stage || '-', inline: true },
      { name: '言語 / 国', value: `${lang || '-'} / ${country}`, inline: true },
      { name: 'UA', value: ua || '-', inline: false },
    ],
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      console.warn(`[feedback] discord webhook failed: ${res.status}`);
      return json({ ok: false }, 502, corsHeaders(origin));
    }
  } catch (err) {
    console.warn(`[feedback] discord webhook error: ${err}`);
    return json({ ok: false }, 502, corsHeaders(origin));
  }

  return json({ ok: true }, 200, corsHeaders(origin));
}

// ============================================================
// メインルーター
// ============================================================
const ID_RE = /^[a-zA-Z0-9]{8,12}$/;

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin') ?? '') });
    }

    if (method === 'GET' && path === '/api/session') {
      return handleSession(request, env);
    }

    if (method === 'POST' && path === '/api/rollaxy/share') {
      return handleSharePost(request, env);
    }

    if (method === 'GET' && path === '/api/rollaxy/ranking') {
      return handleRanking(request, env);
    }

    if (method === 'POST' && path === '/api/rollaxy/player') {
      return handlePlayerUpdate(request, env);
    }

    if (method === 'GET' && path === '/api/rollaxy/achievements') {
      return handleAchievementsGet(request, env);
    }

    if (method === 'POST' && path === '/api/rollaxy/achievements/unlock') {
      return handleAchievementsUnlock(request, env);
    }

    if (method === 'POST' && path === '/api/rollaxy/report') {
      return handleReport(request, env);
    }

    if (method === 'POST' && path === '/api/rollaxy/feedback') {
      return handleFeedback(request, env);
    }

    if (method === 'POST' && path === '/api/admin/cleanup') {
      return handleCleanup(request, env);
    }

    if (method === 'POST' && path === '/api/admin/clear-ogp-cache') {
      return handleClearOgpCache(request, env);
    }

    const shareMatch = path.match(/^\/games\/rollaxy\/share\/([^/]+)$/);
    if (shareMatch && method === 'GET') {
      const id = shareMatch[1];
      return ID_RE.test(id) ? handleSharePage(id, env) : sharePage404();
    }

    const ogpMatch = path.match(/^\/games\/rollaxy\/ogp\/([^/]+)$/);
    if (ogpMatch && method === 'GET') {
      const id = ogpMatch[1];
      if (!ID_RE.test(id)) return new Response('Not found', { status: 404 });
      return handleOgp(id, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};
