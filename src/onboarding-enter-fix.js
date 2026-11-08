'use strict';

// Pressing Enter on the first-run screen used to create an account, so people
// who already had one (for example from the website) saw "already registered".
// Enter now signs in first and only creates an account when none matches.
(() => {
  const passEl = document.getElementById('pass');
  const emailEl = document.getElementById('email');
  const msgEl = document.getElementById('acctMsg');
  const btnLogin = document.getElementById('btnLogin');
  if (!passEl || !emailEl || !msgEl || !btnLogin || !window.onb) return;

  const say = (text, isErr) => {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('err', !!isErr);
  };
  let busy = false;

  passEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (busy) return;
    const email = (emailEl.value || '').trim();
    const pass = passEl.value || '';
    if (!email || !pass) { say('Enter your email and a password.', true); return; }
    busy = true;
    say('Working… the first request can take up to a minute while the service wakes up.');
    let r = await window.onb.login(email, pass);
    if (!(r && r.ok) && r && r.error === 'Wrong email or password.') {
      const s = await window.onb.signup(email, pass);
      if (s && s.ok) r = s;
      else if (s && /already registered/i.test(s.error || '')) r = { ok: false, error: 'Wrong password for this account.' };
      else r = s;
    }
    busy = false;
    if (r && r.ok) { btnLogin.click(); return; }
    say((r && r.error) || 'Something went wrong.', true);
  }, true);
})();
