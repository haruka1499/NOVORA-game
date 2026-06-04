'use strict';

// ============================================================
// FEEDBACK — ユーザーからのフィードバック送信モーダル
// ============================================================
// スタート画面 / ゲームオーバー / クリア画面 から共通モーダルを開き、
// /api/rollaxy/feedback 経由で Discord webhook に転送する。
// クライアント側は: 文字数カウンタ + 空文字時 disabled + 連投ガード のみ。
// 本格的なバリデーション・サニタイズはサーバー側で実施。
// ============================================================

const _fb = {
  modal:    document.getElementById('feedback-modal'),
  text:     document.getElementById('feedback-text'),
  counter:  document.getElementById('feedback-counter'),
  status:   document.getElementById('feedback-status'),
  sendBtn:  document.getElementById('feedback-send'),
  cancelBtn:document.getElementById('feedback-cancel'),
};
let _fbSource  = 'unknown';
let _fbSending = false;

function _fbReset() {
  if (!_fb.modal) return;
  _fb.text.value = '';
  _fb.counter.textContent = '0 / 1000';
  _fb.status.textContent = '';
  _fb.status.className = '';
  _fb.sendBtn.disabled = true;
  _fb.sendBtn.textContent = T('feedbackSend');
  _fb.cancelBtn.textContent = T('feedbackCancel');
  _fb.text.placeholder = T('feedbackPlaceholder');
  _fbSending = false;
}

function openFeedbackModal(source) {
  if (!_fb.modal) return;
  _fbSource = source || 'unknown';
  _fbReset();
  _fb.modal.style.display = 'flex';
  // モバイルでスクロール抑止のため focus はわずかに遅延
  setTimeout(() => _fb.text && _fb.text.focus(), 50);
}

function closeFeedbackModal() {
  if (_fb.modal) _fb.modal.style.display = 'none';
}

function _fbContext() {
  return {
    player_id:    typeof getPlayerId    === 'function' ? getPlayerId()    : null,
    display_name: typeof getDisplayName === 'function' ? getDisplayName() : null,
    score:        typeof score          === 'number'   ? score            : null,
    mode:         typeof currentModeId  === 'string'   ? currentModeId    : null,
    stage_id:     typeof currentStageId === 'string'   ? currentStageId   : null,
    lang:         typeof currentLang    === 'string'   ? currentLang      : 'ja',
  };
}

async function _fbSubmit() {
  if (_fbSending) return;
  const txt = _fb.text.value.trim();
  if (txt.length < 1 || txt.length > 1000) return;

  _fbSending = true;
  _fb.sendBtn.disabled = true;
  _fb.sendBtn.textContent = T('feedbackSending');
  _fb.status.textContent = '';
  _fb.status.className = '';

  try {
    const res = await fetch('/api/rollaxy/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:    txt,
        source:  _fbSource,
        context: _fbContext(),
      }),
    });
    if (res.ok) {
      _fb.status.textContent = T('feedbackThanks');
      _fb.status.className = 'ok';
      setTimeout(() => { closeFeedbackModal(); }, 1500);
    } else if (res.status === 429) {
      _fb.status.textContent = T('feedbackRateLimit');
      _fb.status.className = 'err';
      _fbSending = false;
      _fb.sendBtn.disabled = false;
      _fb.sendBtn.textContent = T('feedbackSend');
    } else {
      _fb.status.textContent = T('feedbackError');
      _fb.status.className = 'err';
      _fbSending = false;
      _fb.sendBtn.disabled = false;
      _fb.sendBtn.textContent = T('feedbackSend');
    }
  } catch (_) {
    _fb.status.textContent = T('feedbackError');
    _fb.status.className = 'err';
    _fbSending = false;
    _fb.sendBtn.disabled = false;
    _fb.sendBtn.textContent = T('feedbackSend');
  }
}

// ─ イベント配線 ─
if (_fb.modal) {
  _fb.text.addEventListener('input', () => {
    const len = _fb.text.value.length;
    _fb.counter.textContent = `${len} / 1000`;
    _fb.sendBtn.disabled = (_fbSending || _fb.text.value.trim().length < 1);
  });
  on(_fb.sendBtn,   () => { playDecisionSound(); _fbSubmit(); });
  on(_fb.cancelBtn, () => { playBackSound();     closeFeedbackModal(); });
  // 背景クリックで閉じる
  on(_fb.modal, (e) => {
    if (e.target === _fb.modal && !_fbSending) closeFeedbackModal();
  });
}

// 各エントリボタンを配線（data-source 属性で送信元を区別）。
// gameover 側のボタンはクリア時にも兼用されるため、next-stage-btn が表示中なら 'clear' に差し替える。
document.querySelectorAll('.feedback-entry').forEach((btn) => {
  on(btn, () => {
    playDecisionSound();
    let src = btn.dataset.source || 'unknown';
    if (src === 'gameover') {
      const nextBtn = document.getElementById('next-stage-btn');
      if (nextBtn && nextBtn.style.display !== 'none' && nextBtn.offsetParent !== null) {
        src = 'clear';
      }
    }
    openFeedbackModal(src);
  });
});
