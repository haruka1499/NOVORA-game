'use strict';
// ============================================================
// NOVORA GAME — サイト共通 i18n
// ゲームページ（/games/rollaxy/）以外の全ページで読み込む
// ゲームの lang.js と同じ localStorage キー "novora_lang" を共有する
// ============================================================

const _I18N = {
  ja: {
    // ── ナビ ──
    navGames:    'ゲーム',
    navAbout:    'About',
    navPrivacy:  'Privacy',
    navCredits:  'Credits',
    navRanking:  'ランキング',
    navProfile:  '👤 プロフィール',
    scoreUnit:   '点',
    navRollaxy:  'Rollaxy',
    // ── フッター ──
    footerHome:    'Home',
    footerGames:   'ゲーム',
    footerPrivacy: 'プライバシーポリシー',
    // ── トップページ / ゲーム一覧 ──
    siteDesc:      'ブラウザで遊べるゲーム集 — インストール不要',
    featured:      'Featured Games',
    rollaxyDesc:   '宇宙をテーマにした落ちものパズル。天体を合体させて銀河団を目指せ。',
    playNow:       '今すぐ遊ぶ ▶',
    gamesPageDesc: 'ブラウザで遊べるゲーム一覧',
    // ── ランキングページ ──
    rankingTitle: '🏆 Rollaxy ランキング',
    tabEndless:   'エンドレス',
    tabTime:      'タイムアタック',
    tabSpeedrun:  'スピードラン',
    tabAll:       '全期間',
    tabWeekly:    '今週',
    tabDaily:     '今日',
    myBestLabel:  '👤 あなたのベスト',
    rankLoading:  '読み込み中...',
    rankError:    '読み込みに失敗しました。しばらくしてから再試行してください。',
    rankEmpty:    'まだエントリーがありません。プレイして記録を作ろう！',
    backToGame:   '▶ ゲームに戻る',
    // ── プロフィールページ ──
    profileTitle:       '👤 プロフィール設定',
    profileNameCard:    '表示名',
    profileNamePh:      '15文字以内（日本語OK）',
    profileNameSave:    '保存',
    profileNameSaved:   '✓ 保存しました',
    profileNameEmpty:   '1文字以上入力してください',
    profileNameHint:    'ランキングに表示される名前です。日本語・英数字など15文字以内で設定できます。',
    profileCodeCard:    'ゲストコード（識別ID）',
    profileCodeNote:    'このコードはブラウザに紐付いた識別子です。同じブラウザで遊ぶ限り同じコードが使われます。異なるブラウザ・デバイスでは別のコードが発行されます。',
    profileCopyBtn:     'コピー',
    profileCopied:      '✓ コピー済み',
    profileBestCard:    'Rollaxy ベストスコア',
    profileBestLink:    '🔗 シェアページを見る',
    profileNoData:      'まだ記録がありません',
    profileRecentCard:  '最近のプレイ記録',
    profileNoRecent:    'まだシェア記録がありません',
    profilePlayBtn:     '▶ Rollaxy をプレイ',
    profileRankBtn:     '🏆 ランキング',
    profileBackBtn:     '▶ ゲームに戻る',
  },
  en: {
    // ── Nav ──
    navGames:    'Games',
    navAbout:    'About',
    navPrivacy:  'Privacy',
    navCredits:  'Credits',
    navRanking:  'Ranking',
    navProfile:  '👤 Profile',
    scoreUnit:   'pts',
    navRollaxy:  'Rollaxy',
    // ── Footer ──
    footerHome:    'Home',
    footerGames:   'Games',
    footerPrivacy: 'Privacy Policy',
    // ── Top page / Game list ──
    siteDesc:      'Free browser games — no installation required',
    featured:      'Featured Games',
    rollaxyDesc:   'A space-themed falling merge puzzle. Combine celestial bodies and aim for the galaxy cluster.',
    playNow:       'Play Now ▶',
    gamesPageDesc: 'Free browser games — play instantly',
    // ── Ranking page ──
    rankingTitle: '🏆 Rollaxy Ranking',
    tabEndless:   'Endless',
    tabTime:      'Time Attack',
    tabSpeedrun:  'Speedrun',
    tabAll:       'All Time',
    tabWeekly:    'This Week',
    tabDaily:     'Today',
    myBestLabel:  '👤 Your Best',
    rankLoading:  'Loading...',
    rankError:    'Failed to load. Please try again later.',
    rankEmpty:    'No entries yet. Play and set a record!',
    backToGame:   '▶ Back to Game',
    // ── Profile page ──
    profileTitle:       '👤 Profile Settings',
    profileNameCard:    'Display Name',
    profileNamePh:      'Up to 15 characters',
    profileNameSave:    'Save',
    profileNameSaved:   '✓ Saved',
    profileNameEmpty:   'Please enter at least 1 character',
    profileNameHint:    'This name appears in the ranking. Up to 15 characters.',
    profileCodeCard:    'Guest Code (ID)',
    profileCodeNote:    'This code is tied to your browser. The same code is used as long as you play on the same browser. A different code is issued on different browsers or devices.',
    profileCopyBtn:     'Copy',
    profileCopied:      '✓ Copied',
    profileBestCard:    'Rollaxy Best Score',
    profileBestLink:    '🔗 View Share Page',
    profileNoData:      'No record yet',
    profileRecentCard:  'Recent Play History',
    profileNoRecent:    'No share history yet',
    profilePlayBtn:     '▶ Play Rollaxy',
    profileRankBtn:     '🏆 Ranking',
    profileBackBtn:     '▶ Back to Game',
  },
  zh: {
    // ── 导航 ──
    navGames:    '游戏',
    navAbout:    'About',
    navPrivacy:  'Privacy',
    navCredits:  'Credits',
    navRanking:  '排行榜',
    navProfile:  '👤 个人资料',
    scoreUnit:   '分',
    navRollaxy:  'Rollaxy',
    // ── 页脚 ──
    footerHome:    'Home',
    footerGames:   '游戏',
    footerPrivacy: '隐私政策',
    // ── 首页 / 游戏列表 ──
    siteDesc:      '免费网页游戏 — 无需安装',
    featured:      '推荐游戏',
    rollaxyDesc:   '以宇宙为主题的下落合并益智游戏。合并天体，挑战星系团。',
    playNow:       '立即游玩 ▶',
    gamesPageDesc: '免费网页游戏列表',
    // ── 排行榜页面 ──
    rankingTitle: '🏆 Rollaxy 排行榜',
    tabEndless:   '无尽模式',
    tabTime:      '限时挑战',
    tabSpeedrun:  '速通',
    tabAll:       '全部时间',
    tabWeekly:    '本周',
    tabDaily:     '今日',
    myBestLabel:  '👤 我的最高分',
    rankLoading:  '加载中...',
    rankError:    '加载失败，请稍后重试。',
    rankEmpty:    '暂无记录，快去游戏创造记录吧！',
    backToGame:   '▶ 返回游戏',
    // ── 个人资料页面 ──
    profileTitle:       '👤 个人资料设置',
    profileNameCard:    '显示名称',
    profileNamePh:      '最多15个字符',
    profileNameSave:    '保存',
    profileNameSaved:   '✓ 已保存',
    profileNameEmpty:   '请至少输入1个字符',
    profileNameHint:    '此名称将显示在排行榜中，最多15个字符。',
    profileCodeCard:    '访客代码（识别ID）',
    profileCodeNote:    '此代码与您的浏览器绑定。在同一浏览器中游戏时使用相同代码，不同浏览器或设备会生成新代码。',
    profileCopyBtn:     '复制',
    profileCopied:      '✓ 已复制',
    profileBestCard:    'Rollaxy 最高分',
    profileBestLink:    '🔗 查看分享页面',
    profileNoData:      '暂无记录',
    profileRecentCard:  '最近的游戏记录',
    profileNoRecent:    '暂无分享记录',
    profilePlayBtn:     '▶ 开始游戏',
    profileRankBtn:     '🏆 排行榜',
    profileBackBtn:     '▶ 返回游戏',
  },
};

const _LANG_ORDER  = ['ja', 'en', 'zh'];
const _LANG_LABELS = { ja: 'JP', en: 'EN', zh: 'ZH' };
const _LANG_KEY   = 'novora_lang';

// rollaxy_lang（旧キー）からの移行を含む言語検出
// 明示的な保存がない初回は navigator.language から自動検出し、localStorage には書かない
function _detectGlobalLang() {
  const stored = localStorage.getItem(_LANG_KEY) || localStorage.getItem('rollaxy_lang');
  if (stored && _I18N[stored]) return stored;
  const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
  for (const code of _LANG_ORDER) {
    if (nav === code || nav.startsWith(code + '-')) return code;
  }
  return _LANG_ORDER[_LANG_ORDER.length - 1]; // 対応言語なし → 最後の言語（英語）
}
let _curLang = _detectGlobalLang();
document.documentElement.lang = _curLang;

// キーから現在言語の文字列を取得
function TG(key) {
  return (_I18N[_curLang] || _I18N.ja)[key] ?? key;
}

// 言語を切り替えて保存・反映
function setGlobalLang(code) {
  if (!_I18N[code]) return;
  _curLang = code;
  localStorage.setItem(_LANG_KEY, code);
  localStorage.removeItem('rollaxy_lang'); // 旧キー削除
  document.documentElement.lang = code;
  applyGlobalLang();
}

// data-i18n 属性を持つ全要素を現在言語で更新
function applyGlobalLang() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const val = TG(el.dataset.i18n);
    if (typeof val === 'string') el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const val = TG(el.dataset.i18nPh);
    if (typeof val === 'string') el.placeholder = val;
  });
  document.querySelectorAll('.site-lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === _curLang);
  });
  document.dispatchEvent(new CustomEvent('globalLangChange', { detail: { lang: _curLang } }));
}

// ナビの #site-lang-selector に JP/EN ボタンを生成
// nav.js が先に読み込まれて既にボタンを構築済みの場合はスキップ
function buildSiteLangSelector() {
  const el = document.getElementById('site-lang-selector');
  if (!el || el.children.length > 0) return; // nav.js 構築済みなら何もしない
  for (const code of _LANG_ORDER) {
    const btn = document.createElement('button');
    btn.className    = 'site-lang-btn';
    btn.dataset.lang = code;
    btn.textContent  = _LANG_LABELS[code] || code.toUpperCase();
    btn.classList.toggle('active', code === _curLang);
    btn.addEventListener('click', () => setGlobalLang(code));
    el.appendChild(btn);
  }
}

// DOMContentLoaded 後に自動適用
document.addEventListener('DOMContentLoaded', () => {
  buildSiteLangSelector();
  applyGlobalLang();
});
