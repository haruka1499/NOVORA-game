'use strict';

// ============================================================
// research-balance.js — 研究ツリーの定義 + コスト + RP 獲得レート
// ============================================================
// チューニングはこのファイル内で完結する。
// game-research.js のロジックには触らない（数値だけ調整可能）。
//
// 研究ツリーの方針:
//   * Prestige (将来実装の「大Prestige」) でのみリセット。超新星では保持。
//   * 主軸 2 本 (宇宙開発 / 宇宙探査) + 後期 2 軸 (銀河 / 宇宙法則)。
//   * 分岐を持ち、合流ノード (前提複数 AND) で「途中で別軸を進める」を強制。
//   * 「効率系」と「盤面操作系」を分離して、プレイヤーの選択肢を多様化。
//
// 研究ポイント (RP) の獲得 (game-research.js で使用):
//   - スコア駆動: ゲームオーバー時に floor(score * RP.PER_SCORE)
//   - 連鎖駆動:   5 連鎖以上のイベントごとに RP.PER_CHAIN_5UP
//   - 超新星:     超新星実行で RP.PER_SUPERNOVA
//   - 放置:       秒単位で RP.PER_IDLE_SEC (最大 IDLE_CAP_SEC)
//
// effect.type 一覧 (R1 で型のみ定義、R3 でゲーム側ロジック実装):
//   既存系 (R1 で動作):
//     rewardMult        星屑獲得倍率
//     scoreMult         スコア倍率
//     starRateMult      質量/恒星エネルギーレート倍率
//     genCostMult       物質生成器コスト倍率 (負値で割引)
//     skillCharge       初期スキル所持数 (整数加算)
//     timeBonus         time モードの制限時間 (秒加算)
//     civPointMult      超新星の文明ポイント倍率
//     planetCostMult    惑星生成コスト倍率
//   R3 で実装予定 (定義のみ):
//     offlineRateMult   オフライン精算レート倍率
//     highTierBonus     高Tier天体から追加報酬
//     highTierSpawnMult 高Tier天体の出現率
//     previewLength     次予告の改善
//     spawnRateMult     生成器の生成量
//     fallSpeedMult     落下速度倍率 (<1 で遅く)
//     gravityWell       盤面引き寄せ
//     chainMultBonus    連鎖倍率加算
//     planetBonus       惑星依存ボーナス
//     mergeAssist       合成補助 (近接判定緩和)
//
// ============================================================

const RESEARCH_BALANCE = {
  // ── RP 獲得レート ──
  RP_PER_SCORE:        0.01,    // 100 score = +1 RP (2 分で 500 点 → +5 RP)
  RP_PER_CHAIN_5UP:    2,       // 5連鎖以上の連鎖イベントごと
  RP_PER_SUPERNOVA:    50,      // 超新星実行で
  RP_PER_IDLE_SEC:     0.02,    // 放置 1 秒あたり (12 h = +864 RP)
  RP_IDLE_CAP_SEC:     12 * 3600,
};

// ── ツリーノード定義 ──
// axis: 'dev'|'explore'|'galaxy'|'cosmic_law' (横並びの軸)
// tier: 同軸内での横並び順 (0=根、大きいほど右)
// prereqs: 全てを満たすと購入可能 (AND)
// cost: 研究ポイントコスト
// effect: 取得時に getModifier 経由で適用 (null は中継ノード)
const RESEARCH_TREE = [
  // ============ Axis 1: 宇宙開発 ============
  { id: 'root_dev', axis: 'dev', tier: 0, cost: 0, prereqs: [], effect: null,
    nameJa: '宇宙開発開始', nameEn: 'Start of Cosmic Dev', nameZh: '宇宙开发开始',
    descJa: '研究ツリー開始ノード', descEn: 'Root node', descZh: '研究树起点' },

  { id: 'mining', axis: 'dev', tier: 1, cost: 5, prereqs: ['root_dev'],
    effect: { type: 'rewardMult', value: 0.20 },
    nameJa: '星屑採掘', nameEn: 'Stardust Mining', nameZh: '星屑采掘',
    descJa: '星屑獲得 +20%', descEn: '+20% stardust gain', descZh: '星屑获得 +20%' },

  // ─ 採掘効率化 系 ─
  { id: 'mining_eff', axis: 'dev', tier: 2, cost: 15, prereqs: ['mining'],
    effect: { type: 'rewardMult', value: 0.25 },
    nameJa: '採掘効率化', nameEn: 'Mining Efficiency', nameZh: '采掘高效化',
    descJa: '星屑獲得 +25% (累積)', descEn: '+25% stardust (stacks)', descZh: '星屑获得 +25%（叠加）' },

  { id: 'deep_mining', axis: 'dev', tier: 3, cost: 60, prereqs: ['mining_eff'],
    effect: { type: 'highTierBonus', value: 0.50 },
    nameJa: '深宇宙採掘', nameEn: 'Deep Space Mining', nameZh: '深空采掘',
    descJa: '高Tier天体から追加報酬 +50%', descEn: '+50% bonus from high-tier bodies', descZh: '高Tier天体追加报酬 +50%' },

  { id: 'quantum_mining', axis: 'dev', tier: 3, cost: 80, prereqs: ['mining_eff'],
    effect: { type: 'offlineRateMult', value: 0.50 },
    nameJa: '量子採掘', nameEn: 'Quantum Mining', nameZh: '量子采掘',
    descJa: 'オフライン精算 +50%', descEn: '+50% offline gain rate', descZh: '离线收益 +50%' },

  // ─ 回収システム 系 ─
  { id: 'recovery', axis: 'dev', tier: 2, cost: 15, prereqs: ['mining'],
    effect: { type: 'rewardMult', value: 0.15 },
    nameJa: '回収システム', nameEn: 'Recovery System', nameZh: '回收系统',
    descJa: '自動回収解放 (+星屑 +15%)', descEn: 'Auto-collect (+15% stardust)', descZh: '自动回收 (+星屑 15%)' },

  { id: 'recovery_drone', axis: 'dev', tier: 3, cost: 50, prereqs: ['recovery'],
    effect: { type: 'rewardMult', value: 0.20 },
    nameJa: '回収ドローン', nameEn: 'Recovery Drone', nameZh: '回收无人机',
    descJa: '回収速度 +20% (星屑加算)', descEn: '+20% recovery speed', descZh: '回收速度 +20%' },

  { id: 'auto_mining_net', axis: 'dev', tier: 3, cost: 70, prereqs: ['recovery'],
    effect: { type: 'offlineRateMult', value: 0.30 },
    nameJa: '自律採掘網', nameEn: 'Autonomous Mining Network', nameZh: '自律采掘网',
    descJa: 'オフライン +30%', descEn: '+30% offline gain', descZh: '离线 +30%' },

  // ─ 生成技術 系 ─
  { id: 'gen_tech', axis: 'dev', tier: 2, cost: 15, prereqs: ['mining'],
    effect: { type: 'starRateMult', value: 0.20 },
    nameJa: '生成技術', nameEn: 'Generation Tech', nameZh: '生成技术',
    descJa: '生成性能 +20% (恒星レート)', descEn: '+20% star rate', descZh: '恒星速率 +20%' },

  { id: 'high_density', axis: 'dev', tier: 3, cost: 60, prereqs: ['gen_tech'],
    effect: { type: 'highTierSpawnMult', value: 0.25 },
    nameJa: '高密度生成', nameEn: 'High-Density Generation', nameZh: '高密度生成',
    descJa: '高Tier出現率 +25%', descEn: '+25% high-tier spawn rate', descZh: '高Tier出现率 +25%' },

  { id: 'gen_control', axis: 'dev', tier: 3, cost: 50, prereqs: ['gen_tech'],
    effect: { type: 'previewLength', value: 1 },
    nameJa: '生成制御', nameEn: 'Generation Control', nameZh: '生成控制',
    descJa: '次予告 +1 個', descEn: '+1 next preview slot', descZh: '下一预告 +1' },

  { id: 'mass_gen', axis: 'dev', tier: 3, cost: 70, prereqs: ['gen_tech'],
    effect: { type: 'spawnRateMult', value: 0.30 },
    nameJa: '大量生成', nameEn: 'Mass Generation', nameZh: '大量生成',
    descJa: '生成量 +30%', descEn: '+30% spawn quantity', descZh: '生成量 +30%' },

  // 合流: 深宇宙採掘 + 生成技術
  { id: 'orbital_factory', axis: 'dev', tier: 4, cost: 200,
    prereqs: ['deep_mining', 'gen_tech'],
    effect: { type: 'rewardMult', value: 0.50 },
    nameJa: '軌道工場', nameEn: 'Orbital Factory', nameZh: '轨道工厂',
    descJa: '生産倍率 +50% (大型システム解放)', descEn: '+50% production / unlocks large systems', descZh: '生产倍率 +50%' },

  // ============ Axis 2: 宇宙探査 ============
  { id: 'root_explore', axis: 'explore', tier: 0, cost: 100, prereqs: ['mining'],
    effect: null,
    nameJa: '宇宙探査', nameEn: 'Space Exploration', nameZh: '宇宙探索',
    descJa: '探査軸の開始', descEn: 'Start of exploration axis', descZh: '探索分支起点' },

  // ─ 惑星開拓 ─
  { id: 'planet_dev', axis: 'explore', tier: 1, cost: 200, prereqs: ['root_explore'],
    effect: { type: 'planetCostMult', value: -0.20 },
    nameJa: '惑星開拓', nameEn: 'Planet Development', nameZh: '行星开拓',
    descJa: '惑星生成コスト -20%', descEn: '-20% planet cost', descZh: '行星生成成本 -20%' },

  { id: 'colonize', axis: 'explore', tier: 2, cost: 600, prereqs: ['planet_dev'],
    effect: { type: 'civPointMult', value: 0.25 },
    nameJa: '居住化', nameEn: 'Colonization', nameZh: '居住化',
    descJa: '文明ポイント +25%', descEn: '+25% civilization points', descZh: '文明点 +25%' },

  { id: 'planet_industry', axis: 'explore', tier: 2, cost: 600, prereqs: ['planet_dev'],
    effect: { type: 'planetBonus', value: 0.30 },
    nameJa: '惑星産業', nameEn: 'Planetary Industry', nameZh: '行星产业',
    descJa: '惑星 1 個あたり +30% 報酬', descEn: '+30% reward per planet', descZh: '每行星 +30% 报酬' },

  // ─ 恒星研究 ─
  { id: 'star_research', axis: 'explore', tier: 1, cost: 200, prereqs: ['root_explore'],
    effect: { type: 'starRateMult', value: 0.30 },
    nameJa: '恒星研究', nameEn: 'Stellar Research', nameZh: '恒星研究',
    descJa: '恒星レート +30%', descEn: '+30% star rate', descZh: '恒星速率 +30%' },

  { id: 'fusion_control', axis: 'explore', tier: 2, cost: 500, prereqs: ['star_research'],
    effect: { type: 'starRateMult', value: 0.40 },
    nameJa: '核融合制御', nameEn: 'Fusion Control', nameZh: '核聚变控制',
    descJa: '恒星レート +40% (累積)', descEn: '+40% star rate (stacks)', descZh: '恒星速率 +40%（叠加）' },

  { id: 'giant_star', axis: 'explore', tier: 2, cost: 700, prereqs: ['star_research'],
    effect: { type: 'highTierSpawnMult', value: 0.35 },
    nameJa: '巨星化', nameEn: 'Giant Star', nameZh: '巨星化',
    descJa: '高Tier出現率 +35% (累積)', descEn: '+35% high-tier spawn (stacks)', descZh: '高Tier出现率 +35%（叠加）' },

  { id: 'supernova_eng', axis: 'explore', tier: 2, cost: 1000, prereqs: ['star_research'],
    effect: { type: 'civPointMult', value: 0.40 },
    nameJa: '超新星工学', nameEn: 'Supernova Engineering', nameZh: '超新星工学',
    descJa: '文明ポイント +40%', descEn: '+40% civ points', descZh: '文明点 +40%' },

  // ─ 重力工学 (盤面操作系) ─
  { id: 'gravity_eng', axis: 'explore', tier: 1, cost: 250, prereqs: ['root_explore'],
    effect: { type: 'fallSpeedMult', value: -0.10 },
    nameJa: '重力工学', nameEn: 'Gravity Engineering', nameZh: '引力工程',
    descJa: '落下速度 -10% (操作余裕)', descEn: '-10% fall speed', descZh: '下落速度 -10%' },

  { id: 'orbit_control', axis: 'explore', tier: 2, cost: 600, prereqs: ['gravity_eng'],
    effect: { type: 'fallSpeedMult', value: -0.15 },
    nameJa: '軌道制御', nameEn: 'Orbit Control', nameZh: '轨道控制',
    descJa: '落下速度 -15% (累積)', descEn: '-15% fall speed (stacks)', descZh: '下落速度 -15%（叠加）' },

  { id: 'gravity_ops', axis: 'explore', tier: 2, cost: 600, prereqs: ['gravity_eng'],
    effect: { type: 'mergeAssist', value: 0.20 },
    nameJa: '重力操作', nameEn: 'Gravity Manipulation', nameZh: '引力操作',
    descJa: '合成判定緩和 +20%', descEn: '+20% merge tolerance', descZh: '合成判定 +20%' },

  { id: 'singularity', axis: 'explore', tier: 2, cost: 800, prereqs: ['gravity_eng'],
    effect: { type: 'gravityWell', value: 0.50 },
    nameJa: '特異点研究', nameEn: 'Singularity Research', nameZh: '奇点研究',
    descJa: '盤面引き寄せ +50%', descEn: '+50% gravity well effect', descZh: '盘面引力 +50%' },

  // 合流: 軌道工場 + 惑星開拓
  { id: 'space_station', axis: 'explore', tier: 3, cost: 1500,
    prereqs: ['orbital_factory', 'planet_dev'],
    effect: { type: 'rewardMult', value: 0.80 },
    nameJa: '宇宙基地建設', nameEn: 'Space Station Construction', nameZh: '太空基地建设',
    descJa: '星屑 +80% (新コンテンツ解放)', descEn: '+80% stardust / new content', descZh: '星屑 +80% / 新内容' },

  // ============ Axis 3: 銀河開拓 ============
  // 合流: 宇宙基地建設 + 超新星工学
  { id: 'galaxy_dev', axis: 'galaxy', tier: 0, cost: 3000,
    prereqs: ['space_station', 'supernova_eng'],
    effect: null,
    nameJa: '銀河開拓', nameEn: 'Galactic Development', nameZh: '银河开拓',
    descJa: '銀河軸の開始', descEn: 'Start of galactic axis', descZh: '银河分支起点' },

  { id: 'galaxy_form', axis: 'galaxy', tier: 1, cost: 5000, prereqs: ['galaxy_dev'],
    effect: { type: 'highTierSpawnMult', value: 0.50 },
    nameJa: '銀河形成', nameEn: 'Galaxy Formation', nameZh: '银河形成',
    descJa: '高Tier出現率 +50%', descEn: '+50% high-tier spawn', descZh: '高Tier出现率 +50%' },

  { id: 'galaxy_cluster', axis: 'galaxy', tier: 1, cost: 6000, prereqs: ['galaxy_dev'],
    effect: { type: 'scoreMult', value: 0.40 },
    nameJa: '銀河団工学', nameEn: 'Cluster Engineering', nameZh: '星系团工程',
    descJa: 'スコア +40%', descEn: '+40% score', descZh: '分数 +40%' },

  { id: 'dark_matter', axis: 'galaxy', tier: 1, cost: 8000, prereqs: ['galaxy_dev'],
    effect: { type: 'chainMultBonus', value: 0.20 },
    nameJa: '暗黒物質研究', nameEn: 'Dark Matter Research', nameZh: '暗物质研究',
    descJa: '連鎖倍率 +20%', descEn: '+20% chain multiplier', descZh: '连锁倍率 +20%' },

  { id: 'warp', axis: 'galaxy', tier: 1, cost: 5000, prereqs: ['galaxy_dev'],
    effect: { type: 'offlineRateMult', value: 0.80 },
    nameJa: 'ワープ工学', nameEn: 'Warp Engineering', nameZh: '跃迁工程',
    descJa: '進行高速化 (オフライン +80%)', descEn: '+80% progression speed', descZh: '推进加速 (离线 +80%)' },

  { id: 'multiverse', axis: 'galaxy', tier: 1, cost: 10000, prereqs: ['galaxy_dev'],
    effect: { type: 'civPointMult', value: 1.0 },
    nameJa: '多宇宙理論', nameEn: 'Multiverse Theory', nameZh: '多元宇宙理论',
    descJa: '文明ポイント +100%', descEn: '+100% civ points', descZh: '文明点 +100%' },

  // ============ Axis 4: 宇宙法則改変 ============
  // 合流: 銀河形成 + ワープ工学 + 量子採掘
  { id: 'cosmic_law', axis: 'cosmic_law', tier: 0, cost: 30000,
    prereqs: ['galaxy_form', 'warp', 'quantum_mining'],
    effect: null,
    nameJa: '宇宙法則改変', nameEn: 'Cosmic Law Modification', nameZh: '宇宙法则改变',
    descJa: 'エンドゲーム軸の開始', descEn: 'Endgame axis', descZh: '终局分支起点' },

  { id: 'time_manip', axis: 'cosmic_law', tier: 1, cost: 50000, prereqs: ['cosmic_law'],
    effect: { type: 'offlineRateMult', value: 2.0 },
    nameJa: '時間操作', nameEn: 'Time Manipulation', nameZh: '时间操作',
    descJa: 'オフライン +200%', descEn: '+200% offline gain', descZh: '离线 +200%' },

  { id: 'space_exp', axis: 'cosmic_law', tier: 1, cost: 50000, prereqs: ['cosmic_law'],
    effect: { type: 'spawnRateMult', value: 1.0 },
    nameJa: '空間拡張', nameEn: 'Space Expansion', nameZh: '空间扩张',
    descJa: '生成量 +100%', descEn: '+100% spawn quantity', descZh: '生成量 +100%' },

  { id: 'prob_ctrl', axis: 'cosmic_law', tier: 1, cost: 60000, prereqs: ['cosmic_law'],
    effect: { type: 'highTierBonus', value: 2.0 },
    nameJa: '確率制御', nameEn: 'Probability Control', nameZh: '概率控制',
    descJa: '高Tier報酬 +200%', descEn: '+200% high-tier bonus', descZh: '高Tier报酬 +200%' },

  { id: 'entropy_ctrl', axis: 'cosmic_law', tier: 1, cost: 70000, prereqs: ['cosmic_law'],
    effect: { type: 'starRateMult', value: 1.5 },
    nameJa: 'エントロピー制御', nameEn: 'Entropy Control', nameZh: '熵控制',
    descJa: '恒星レート +150%', descEn: '+150% star rate', descZh: '恒星速率 +150%' },

  { id: 'new_prestige', axis: 'cosmic_law', tier: 1, cost: 200000, prereqs: ['cosmic_law'],
    effect: null,
    nameJa: '新Prestige階層', nameEn: 'New Prestige Layer', nameZh: '新转生阶层',
    descJa: '大 Prestige 解放 (未実装)', descEn: 'Unlocks Big Prestige (TBD)', descZh: '解锁大转生（待实现）' },
];

// ── 軸メタ情報 (UI 表示順) ──
const RESEARCH_AXES = [
  { id: 'dev',         nameJa: '宇宙開発', nameEn: 'Cosmic Development', nameZh: '宇宙开发' },
  { id: 'explore',     nameJa: '宇宙探査', nameEn: 'Exploration',         nameZh: '宇宙探索' },
  { id: 'galaxy',      nameJa: '銀河開拓', nameEn: 'Galactic',            nameZh: '银河开拓' },
  { id: 'cosmic_law',  nameJa: '宇宙法則', nameEn: 'Cosmic Law',          nameZh: '宇宙法则' },
];
