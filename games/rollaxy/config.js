'use strict';

// ============================================================
// CONFIG — ゲームバランス調整値。ここを変更してチューニングします
// ============================================================
const CFG = {

  // キャンバス論理解像度（物理演算はこのサイズ基準）
  W: 400,
  H: 772,   // +72: ヘッダー分の余白を下方にシフト（ゲームエリア高さは維持）

  // 天体進行バーの高さ（drawBodyBar と共有）
  BAR_H: 68,

  // ゲームボックス内側座標（元の値から Y 方向すべて +72）
  BOX: {
    L:  18,   // 左壁内側 X
    R: 382,   // 右壁内側 X
    T: 240,   // 上端 Y (元: 168)
    B: 760,   // 底面 Y (元: 688)
    W:  18,   // 壁の厚さ
    GL:  8,   // ガイド壁左内端 X（BOX.L より 10px 広め）
    GR: 392,  // ガイド壁右内端 X（BOX.R より 10px 広め）
  },

  // 危険ライン Y（これ以上天体が積み上がると危険カウント開始）
  DANGER_Y: 248,   // 元: 176

  // 操作中天体の表示 Y（ここから落下）
  DROP_Y: 190,   // 元: 118

  // 物理エンジン設定
  PHYS: {
    GRAVITY:  2.0,   // 重力（大きいほど速く落下）
    FRIC:     0.10,  // 摩擦係数（大きいほど滑りにくい）
    FRIC_AIR: 0.015, // 空気抵抗（高いほど空中での減衰が大きい）
    REST:     0.05,  // 弾性（0=弾まない / 1=完全弾性）
    FRIC_S:   0.20,   // 静止摩擦係数
    SLOP:     0.05,  // 許容重複量（大きいほど食い込み補正が緩やか）
    SUBSTEPS:  4,    // 1フレームを分割して計算する回数
    POS_ITER: 16,    // 位置の衝突解決イテレーション数
    VEL_ITER: 12,    // 速度の衝突解決イテレーション数
  },

  // 天体定義 n=名前 e=絵文字 r=半径(px) c=色 s=スコア
  // n=表示名(日本語) key=画像ファイル名(英語) e=絵文字 r=半径(px) c=色 s=スコア
  BODIES: [
    { n: '宇宙塵',         key: 'dust',          e: '💫', r:  12, c: '#b0a090', s:   1 },
    { n: '小惑星',         key: 'asteroid',       e: '🪨', r:  18, c: '#807060', s:   2 },
    { n: '月',             key: 'moon',           e: '🌙', r:  25, c: '#d0c8b0', s:   4 },
    { n: '地球',           key: 'earth',          e: '🌍', r:  33, c: '#3388cc', s:   7 },
    { n: '木星',           key: 'jupiter',        e: '🪐', r:  42, c: '#d4a870', s:  11 },
    { n: '太陽',           key: 'sun',            e: '☀️', r:  51, c: '#ffcc00', s:  16 },
    { n: '赤色巨星',       key: 'red_giant',      e: '🔴', r:  61, c: '#cc2200', s:  22 },
    { n: '白色矮星',       key: 'white_dwarf',    e: '⭐', r:  70, c: '#c8d8ff', s:  29 },
    { n: '中性子星',       key: 'neutron_star',   e: '💠', r:  79, c: '#2244cc', s:  37 },
    { n: 'ブラックホール', key: 'black_hole',     e: '🌑', r:  88, c: '#110022', s:  46 },
    { n: '銀河',           key: 'galaxy',         e: '🌌', r:  97, c: '#7744cc', s:  56 },
    { n: '銀河団',         key: 'galaxy_cluster', e: '🌐', r: 106, c: '#aa44ff', s:  68 },
  ],

  // ゲームルール
  RULES: {
    MAX_SPAWN:    4,    // 出現する最大天体番号（0始まり, 4=木星）
    COOLDOWN:     600,    // 落下後の操作ロック時間 (ms)
    DANGER_F:    90,    // 危険状態継続フレーム数 → ゲームオーバー
    GRACE_MS:       2200, // 新天体のゲームオーバー判定除外時間 (ms)
    MERGE_GRACE_MS:  100, // 合成直後の天体が再び合成に使われるまでの猶予 (ms)
    MERGE_MARGIN:   0.04, // 近距離判定マージン係数（body.r × この値 px 以内なら合成扱い）
    MERGE_BURST:     3.5, // 合体時の弾け飛び最大速度（0=弾けない、大きいほど激しく飛ぶ）

    // 合成生成位置の速度重み指数
    // 値が大きいほど「遅い側」への偏りが強くなる
    // 1.0 = ゆるやかな偏り / 2.0 = 中程度（デフォルト） / 4.0 以上 = ほぼスナップ
    MERGE_POS_BIAS:  0.5,
    // 速度ゼロ割り防止と「ほぼ静止」扱いの閾値 (px/frame)
    // 小さすぎると静止 vs 微速で挙動が不安定になる
    MERGE_POS_EPS:   0.5,

    // 連鎖判定ウィンドウ (ms)
    // 前の合成からこの時間内に次の合成が起きると連鎖カウントが続く
    CHAIN_WINDOW_MS: 800,
  },

  // ============================================================
  // ゲームモード
  // ============================================================
  // type: 'tutorial' = STAGES を順に進める導入。各ステージ固有の目標を達成でクリア。
  //       'time'     = 制限時間内にスコアを稼ぐメインモード（timeLimit 秒で終了）。
  //       'endless'  = ゲームオーバーまで（従来の通常モード）。
  // unlockLevel: 解禁に必要なプレイヤーレベル（将来用。0 = 常時解禁）
  // timeLimit: 制限時間(秒)。time モードのみ使用。
  // ランキング送信は endless のみ（time/tutorial はローカル進行。game.js doGameOver 参照）。
  // ※ DEFAULT_MODE はチュートリアル未完了時 game.js が 'tutorial' に上書きする。
  MODES: [
    { id: 'tutorial', type: 'tutorial', nameJa: 'チュートリアル', nameEn: 'Tutorial',    nameZh: '教程', unlockLevel: 0 },
    { id: 'time',     type: 'time',     nameJa: 'タイムアタック', nameEn: 'Time Attack', nameZh: '限时', unlockLevel: 0, timeLimit: 180 },
    { id: 'endless',  type: 'endless',  nameJa: 'エンドレス',     nameEn: 'Endless',     nameZh: '无尽', unlockLevel: 0 },
    // speedrun: 銀河団 (最深天体) を作成するまでのタイムを競う。失敗 (天体あふれ) = 記録なし。
    { id: 'speedrun', type: 'speedrun', nameJa: 'スピードラン', nameEn: 'Speedrun',     nameZh: '速通', unlockLevel: 0 },
  ],
  DEFAULT_MODE: 'endless',

  // ステージ定義（tutorial モード用）。id = "ワールド-ステージ"。
  // 目標スキーマ（複数指定時は全て満たすとクリア）:
  //   goalScore     … このスコア到達
  //   timeLimit     … 制限時間(秒)。超過で失敗（リトライ）
  //   requireSkill  … 指定スキル('bomb'|'upgrade'|'delete')を1回使用
  //   requireAnySkill … 任意スキルを指定回数以上使用
  //   requireTier   … この天体インデックス以上を1度でも生成（9=ブラックホール）
  //   descJa/En/Zh  … プレイ中・スタート画面に表示する目標説明
  STAGES: [
    { id: '1-1', goalScore: 100, unlockLevel: 0,
      descJa: '天体を合成して 100 点を取ろう', descEn: 'Merge bodies to reach 100 points', descZh: '合成天体，达到 100 分' },
    { id: '1-2', goalScore: 100, timeLimit: 60, unlockLevel: 0,
      descJa: '60 秒以内に 100 点を取ろう', descEn: 'Score 100 points within 60 seconds', descZh: '在 60 秒内达到 100 分' },
    { id: '1-3',
      requireAllSkills: { bomb: 1, upgrade: 1, delete: 1 },
      initSkills: { bomb: 1, upgrade: 1, delete: 1 },
      presetBodies: [
        {"bi":0,"x":62,"y":748},{"bi":6,"x":117,"y":699},{"bi":7,"x":246,"y":691},
        {"bi":3,"x":349,"y":727},{"bi":3,"x":51,"y":633},{"bi":4,"x":168,"y":611},
        {"bi":1,"x":36,"y":736},{"bi":1,"x":364,"y":679},{"bi":1,"x":101,"y":623},
        {"bi":5,"x":331,"y":605},{"bi":3,"x":249,"y":588},{"bi":1,"x":364,"y":544},
        {"bi":4,"x":288,"y":523},{"bi":5,"x":85,"y":556},{"bi":6,"x":186,"y":510},
      ],
      unlockLevel: 0,
      descJa: '3種のスキルを 1 回ずつ使おう（各1個付き）', descEn: 'Use each skill once (1 of each given)', descZh: '每种技能各使用 1 次（各附赠1个）' },
    { id: '1-4', goalScore: 150, timeLimit: 60, unlockLevel: 0,
      descJa: '60 秒以内に 150 点を取ろう', descEn: 'Score 150 points within 60 seconds', descZh: '在 60 秒内达到 150 分' },
    { id: '1-5', requireTier: 9, unlockLevel: 0,
      descJa: 'ブラックホールを作ろう（時間制限なし）', descEn: 'Create a Black Hole (no time limit)', descZh: '制造一个黑洞（无时间限制）' },
    { id: '1-6', goalScore: 500, timeLimit: 120, unlockLevel: 0,
      descJa: '120 秒以内に 500 点を取ろう', descEn: 'Score 500 points within 120 seconds', descZh: '在 120 秒内达到 500 分' },
  ],

  // スキル初期所持数（デバッグ・バランス調整用）
  // Infinity を指定すると無制限
  SKILL_INIT_CHARGES: {
    bomb:    1,
    upgrade: 1,
    delete:  1,
  },

  // 爆弾スキル設定
  // 「爆弾」= ユーザーがスキルボタンで選択する bomb スキル
  BOMB: {
    R:       18,  // 爆弾の半径（小惑星=18 と同サイズ）
    RANGE:   42,  // 爆発効果範囲の半径（木星=42 と同程度）
    FUSE_MS: 700, // 衝突から爆発までの導火線時間 (ms)
    SAFE_BI:      5, // このインデックス未満の天体は爆発で即消滅（0〜4: 宇宙塵〜木星）
    DOWNGRADE_BI: 8, // SAFE_BI 以上かつこれ以下の天体は1段階ダウングレード（5〜8: 太陽〜中性子星）
                     // これより上（9〜: ブラックホール・銀河・銀河団）は爆発の影響を受けない
  },

  // モバイルのアドレスバー開閉による高さ変動を無視する閾値 (px)。
  // 幅が同一かつ高さの変化がこの値以下なら canvas を再フィットしない。
  // アドレスバーの高さ（iOS で概ね 60〜120px）より大きく、回転や
  // ソフトキーボード等の本質的な変化（通常 > 140px）より小さい値にする。
  RESIZE_IGNORE_DH: 140,

  // スナップショット・ランキング用バージョン番号
  // 天体定義や盤面フォーマットが変わったときに増やす
  GAME_VERSION: 1,

  // X（Twitter）シェア設定
  SHARE: {
    URL: 'https://novoragame.com/games/rollaxy/', // シェアに含めるゲームの URL（空文字の場合は URL なし）
  },

  // 効果音設定
  SOUND: {
    DEFAULT_VOL: 1.0, // デフォルト音量（0.0〜1.0）。スライダーで変更した値は localStorage に保存される
  },

  // ============================================================
  // META — メタ進行（インクリメンタル）の調整値
  // ============================================================
  // ループ: プレイ → 星屑(stardust)/恒星エネルギー(energy)獲得 → 星屑で物質生成器を
  //          強化 → 恒星サイズ↑ → 自動恒星エネルギー/秒↑（放置でも蓄積）。
  // ※ 文明レベル・研究は次段階。ここでは恒星エネルギーの使い道は未実装（蓄積のみ）。
  META: {
    // プレイ報酬の計算（係数構造。将来アップグレード倍率なども掛けられるよう拡張可能）。
    // stardust = floor((score*PER_SCORE + chainEvents*PER_CHAIN) * modeMult)
    REWARD: {
      STARDUST_PER_SCORE: 0.10, // スコア1点あたり星屑（連鎖倍率込みのスコアに適用）
      ENERGY_PER_SCORE:   0.05, // スコア1点あたり恒星エネルギー
      // モード別倍率（チュートリアルは導入なので控えめ）
      MODE_MULT: { time: 1.0, endless: 1.0, tutorial: 0.3 },
    },
    // 物質生成器（単一・レベル制）。Lv L→L+1 のコスト = floor(BASE_COST * GROWTH^(L-1))。
    GENERATOR: {
      START_LEVEL: 1,   // 初期レベル（最初から最小の恒星が存在）
      MAX_LEVEL:   100, // 上限（暫定）
      BASE_COST:   100, // Lv1→2 のコスト（星屑）
      GROWTH:      1.40, // レベルごとのコスト倍率
    },
    // 恒星：物質生成器が質量(mass)を生産し、質量の 2/3 乗に比例してエネルギーを生成。
    // 質量生成レート: rate = MASS_BASE + (level-1)*MASS_PER_LEVEL  [質量/秒]
    // エネルギー生成レート: energy/sec = ENERGY_K * mass^(2/3)
    STAR: {
      MASS_BASE:      1.0,   // Lv1 の質量生成レート (質量/秒)
      MASS_PER_LEVEL: 1.0,   // レベルごとの増分 (質量/秒)
      ENERGY_K:       0.003, // エネルギー変換係数 (energy/sec = K * mass^(2/3))
      // 恒星の見た目tier。各 bi(BODIES index) に到達する最小レベル。
      // 例: Lv1=宇宙塵(0) … Lv64=ブラックホール(9)。
      TIER_LEVELS: [1, 4, 8, 13, 19, 26, 34, 43, 53, 64, 76, 89],
    },
    // 放置（オフライン）蓄積の上限（秒）。この時間分までしか溜まらない。
    IDLE: { CAP_SEC: 12 * 3600 }, // 最大12時間分

    // 簡易チート対策（クライアント側は「抑止」のみ。本丸は将来のサーバー検証）。
    // 詳細方針は CLAUDE.md「簡易チート対策方針」を参照。
    ANTICHEAT: {
      SIG_SALT: 'rlx_meta_v1', // セーブ署名のソルト（難読化目的・暗号強度なし）
    },

    // ── 文明レベル（消費型）──
    // 恒星エネルギーを支払ってレベルアップ。レベルは研究の解禁ゲート専用（常時ボーナスなし）。
    // Lv L→L+1 のコスト = floor(BASE_COST * GROWTH^(L-1)) 恒星エネルギー。
    CIV: {
      START_LEVEL: 1,
      MAX_LEVEL:   50,
      BASE_COST:   200,
      GROWTH:      1.60,
    },

    // ── 研究ツリー (R1 で全置換) ──
    // 旧 RESEARCH / PERMANENT_RESEARCH は research-balance.js の RESEARCH_TREE に統合済み。
    // バランス調整は research-balance.js で完結する。
    // ノードは「unlock + 効果適用」のみ、コストは researchPoints (RP) で支払う。
    // 詳細は research-balance.js のヘッダーコメント参照。

    // ── 多恒星（Phase 5）──
    // 恒星枠 N 個目の解放コスト（文明ポイント）。COSTS[0] は初期保有なので未使用。
    // 例: 2個目=5pt, 3個目=15pt, 4個目=45pt（おおむね×3）
    STAR_SLOTS: {
      COSTS: [0, 5, 15, 45, 135, 405, 1215, 3645],
      MAX:   8,
    },

    // ── 超新星（Phase 4）──
    // 成長% = mass / GROWTH_DIVISOR（mass 5000 で 100%）。100% 以上で超新星実行可。
    // 1000% で進行不能（ソフトキャップ・mass 蓄積停止）。
    // 報酬 = floor(growth/100) * (1 + planets.length * BONUS_PER_PLANET) 文明ポイント。
    SUPERNOVA: {
      GROWTH_DIVISOR:    50,    // mass→growth% 換算（mass 5000 = 100%）
      READY_AT:          100,   // この成長% 以上で超新星可
      WARN_THRESHOLDS:  [700, 800, 900], // 段階警告（不安定トースト）
      CAP_AT:            1000,  // 進行不能（mass 蓄積停止）。手動超新星は引き続き可
      BONUS_PER_PLANET:  0.20,  // 惑星1個あたり +20% 報酬倍率
    },

    // ── 惑星（Phase 3）──
    // 物質生成器レベルに応じて惑星スロットが解放され、星屑を消費して惑星を生成する。
    // スロット数 = SLOT_LEVELS のうち genLevel 以下の個数。
    // N 個目の惑星コスト = floor(BASE_COST * COST_GROWTH^(N-1)) 星屑。
    // ※ growth% 導入（Phase 4）後はスロット解放条件を growth% ベースへ移行予定。
    PLANET: {
      BASE_COST:   500,
      COST_GROWTH: 3.0,
      MAX_SLOTS:   8,
      // slot k (1-indexed) が解放される物質生成器レベル
      SLOT_LEVELS: [3, 8, 15, 25, 38, 54, 73, 95],
      // 選択可能な惑星テクスチャ（images/cosmos/{key}.jpg）
      TYPES: [
        { key: 'mercury', nameJa: '水星', nameEn: 'Mercury', nameZh: '水星' },
        { key: 'venus',   nameJa: '金星', nameEn: 'Venus',   nameZh: '金星' },
        { key: 'earth',   nameJa: '地球', nameEn: 'Earth',   nameZh: '地球' },
      ],
    },
  },

  // ゲーム用天体画像の表示調整値（image-adjuster.html で決定した値）
  // ゲーム本体 (images/*.png) 専用。OGP用画像 (images/ogp/*.png) の調整値は
  // サーバー側の src/constants.js BODY_IMAGE_ADJUST で別途管理する。
  // scale: カバースケールへの乗数 / ox,oy: 中心からのオフセット（ゲーム px）
  IMAGE_ADJUST: [
    /*  0: 宇宙塵         */ { scale: 1.22, ox:  0.2, oy:  0.1 },
    /*  1: 小惑星         */ { scale: 1.39, ox:  0.0, oy:  1.0 },
    /*  2: 月             */ { scale: 1.23, ox:  0.5, oy:  1.0 },
    /*  3: 地球           */ { scale: 1.19, ox:  0.8, oy:  0.6 },
    /*  4: 木星           */ { scale: 1.09, ox:  0.3, oy:  1.0 },
    /*  5: 太陽           */ { scale: 1.20, ox:  0.0, oy:  0.0 },
    /*  6: 赤色巨星       */ { scale: 1.14, ox:  0.0, oy:  0.0 },
    /*  7: 白色矮星       */ { scale: 1.35, ox:  0.0, oy:  0.0 },
    /*  8: 中性子星       */ { scale: 2.39, ox:  0.0, oy:  1.5 },
    /*  9: ブラックホール */ { scale: 1.20, ox:  0.5, oy:  5.0 },
    /* 10: 銀河           */ { scale: 1.01, ox: -0.1, oy: 10.0 },
    /* 11: 銀河団         */ { scale: 1.05, ox:  0.0, oy:  0.0 },
  ],
};

// ============================================================
// STORAGE_KEYS — localStorage キーの一元管理
// ============================================================
// 【prefix 命名規則】将来の一括削除を見据えて2系統に分ける。
//   novora_  … サイト横断・アカウント系。ゲームをまたいで保持する。
//              個別ゲームの「リセット」では削除しない。
//   rollaxy_ … このゲーム専用。ゲームデータの一括リセット対象。
//
// 【重要】ここの値（キー文字列）は既存データ破壊を避けるため変更しないこと。
// 新規キーは必ずここに定義し、上記 prefix 規則に従って命名する。
const STORAGE_KEYS = {
  // ── novora_ : サイト横断・アカウント系（リセットで保持） ──
  HINT_SHOWN:    'novora_hint_shown',
  NAME_SET:      'novora_name_set',
  PLAYER_ID:     'novora_player_id',
  DISPLAY_NAME:  'novora_display_name',
  SHARE_IDS:     'novora_share_ids',
  BEST_SCORE:         'novora_best_score',
  BEST_SHARE_ID:      'novora_best_share_id',
  BEST_SCORE_TIME:    'novora_best_score_time',
  BEST_SHARE_ID_TIME: 'novora_best_share_id_time',
  BEST_SPEEDRUN_MS:    'novora_best_speedrun_ms',     // スピードランのベストタイム (ms)
  BEST_SHARE_ID_SPEEDRUN: 'novora_best_share_id_speedrun',
  UNLOCKED_MODES:      'rollaxy_unlocked_modes',     // 解放済みモードID配列(JSON)。endless は常に解放。
  ENDLESS_SAVE:        'rollaxy_endless_save',        // エンドレスの自動セーブ(JSON)。盤面+スコア+スキル
  LANG:          'novora_lang',

  // ── rollaxy_ : このゲーム専用（リセット対象） ──
  SFX_VOL:            'rollaxy_sfx_vol',
  TUTORIAL_DONE:      'rollaxy_tutorial_done',         // 4連鎖後の強制スキル使用オンボーディング完了
  STAGE_TUTORIAL_DONE:'rollaxy_stage_tutorial_done',   // 多段チュートリアル(1-1〜1-8)完了
  HI_SCORE:           'rollaxy_hi',
  BODY_MERGES:        'rollaxy_body_merges',
  CHAIN_COUNTS:       'rollaxy_chain_counts',
  SKILL_CHAIN_COUNTS: 'rollaxy_skill_chain_counts',
  TOTAL_CHAINS:       'rollaxy_total_chains',
  TOTAL_MERGES:       'rollaxy_total_merges',
  GAME_COUNT:         'rollaxy_game_count',
  TOTAL_SEC:          'rollaxy_total_sec',
  TOTAL_SCORE:        'rollaxy_total_score',
  TOTAL_DROPS:        'rollaxy_total_drops',
  MAX_TIER:           'rollaxy_max_tier',
  CLUSTER_VANISH:     'rollaxy_cluster_vanish',
  CLUSTER_COUNT:      'rollaxy_cluster_count',
  ACH:                'rollaxy_ach',
  ACTIVE_GOAL:        'rollaxy_active_goal',   // 目標モード中のゴール設定 (JSON)
  LAST_MODE:          'rollaxy_last_mode',     // 最後に選んだモードID
  STAGE_CLEARED:      'rollaxy_stage_cleared',  // クリア済みステージID配列(JSON)
  PLAYER_LEVEL:       'rollaxy_player_level',   // プレイヤーレベル（将来のモード解禁用）
  SKILL_HINT_BOMB:    'rollaxy_skill_hint_bomb',
  SKILL_HINT_UPGRADE: 'rollaxy_skill_hint_upgrade',
  SKILL_HINT_DELETE:  'rollaxy_skill_hint_delete',
  // ── メタ進行（インクリメンタル） ──
  META_STARDUST:      'rollaxy_stardust',          // 所持星屑
  META_ENERGY:        'rollaxy_stellar_energy',    // 所持恒星エネルギー
  META_GEN_LEVEL:     'rollaxy_generator_level',   // 物質生成器レベル
  META_LAST_SAVED:    'rollaxy_meta_last_saved',   // 放置蓄積の基準時刻 (ms)
  META_MASS:          'rollaxy_meta_mass',         // 蓄積質量
  META_CIV_LEVEL:     'rollaxy_civ_level',         // [DEPRECATED R1] 文明レベル
  META_RESEARCH:      'rollaxy_research',           // [DEPRECATED R1] 旧通常研究ID配列
  META_PERM_RESEARCH: 'rollaxy_perm_research',      // [DEPRECATED R1] 旧永続研究ID配列
  META_RESEARCH_TREE: 'rollaxy_research_tree',      // 新ツリー: 取得済みノードID配列(JSON)
  META_RP:            'rollaxy_research_points',    // 研究ポイント保有量
  META_PLANETS:       'rollaxy_planets',            // 生成済み惑星配列(JSON) [{key,name}]
  META_CIV_POINTS:    'rollaxy_civ_points',          // 文明ポイント（超新星で獲得・永続）
  META_SUPERNOVA_CNT: 'rollaxy_supernova_count',     // 通算超新星回数（=宇宙数）
  META_STARS:         'rollaxy_stars',                // 全恒星 [{id,mass,planets}] JSON
  META_ACTIVE_STAR:   'rollaxy_active_star',          // 現在選択中の恒星ID
  META_STAR_SLOTS:    'rollaxy_star_slots',           // 解放済み恒星枠数（初期1）
  META_SIG:           'rollaxy_meta_sig',           // セーブ整合性チェックサム（簡易チート対策）

  // ── レガシー（移行済み・読み取り/削除のみ。新規利用しない） ──
  LEGACY_HI:   'korokoro_hi',
  LEGACY_LANG: 'rollaxy_lang',
};
