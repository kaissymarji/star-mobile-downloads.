/* Password recovery only. No license or subscription records are changed. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('resetForm');
  const status = $('status');
  const save = $('savePassword');
  const account = $('resetAccount');
  const emailLabel = $('resetEmail');
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const isRecovery = query.get('type') === 'recovery'
    || fragment.get('type') === 'recovery'
    || query.has('token_hash') || query.has('code');
  const tokenHash = query.get('token_hash');
  let auth = null;
  let verified = false;

  function message(text, kind = '') {
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setupPasswordToggle(fieldId, buttonId, label) {
    const input = $(fieldId);
    const button = $(buttonId);
    button.addEventListener('click', () => {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(reveal));
      button.setAttribute('aria-label', (reveal ? 'Hide ' : 'Show ') + label);
      button.title = (reveal ? 'Hide ' : 'Show ') + label;
    });
    return () => {
      input.type = 'password';
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Show ' + label);
      button.title = 'Show ' + label;
    };
  }
  const resetNewToggle = setupPasswordToggle('newPassword','toggleNewPassword','new password');
  const resetConfirmToggle = setupPasswordToggle('confirmPassword','toggleConfirmPassword','confirmation password');

  async function start() {
    if (!isRecovery) {
      message('Open the reset-password link from your email, or request a fresh link in the V200 app.', 'error');
      return;
    }
    const cfg = window.V200_COMMUNITY_CONFIG || {};
    if (!window.supabase?.createClient || !/^https:\/\/[a-z0-9.-]+\.supabase\.co\/?$/i.test(cfg.supabaseUrl || '')
        || !/^(sb_publishable_|eyJ)/.test(cfg.supabasePublishableKey || '')) {
      message('Password recovery is temporarily unavailable. Please contact support.', 'error');
      return;
    }
    try {
      const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: true }
      });
      auth = client.auth;
      let session = null;
      if (tokenHash) {
        const result = await auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
        if (result.error) throw result.error;
        session = result.data?.session || null;
      }
      if (!session) {
        const result = await auth.getSession();
        if (result.error) throw result.error;
        session = result.data?.session || null;
      }
      if (!session?.user || !session?.access_token) {
        throw new Error('Your recovery link is expired or invalid. Request a new password-reset email in the app.');
      }
      verified = true;
      // Always derive the account email from the verified Supabase session, never from URL parameters.
      emailLabel.textContent = session.user.email || 'Verified technician account';
      account.hidden = false;
      // Remove session tokens and recovery codes from the browser address bar/history.
      window.history.replaceState(null, document.title, window.location.pathname);
      form.hidden = false;
      message('Link verified. Enter and confirm your new password.');
      $('newPassword').focus();
    } catch (e) {
      account.hidden = true;
      emailLabel.textContent = '';
      form.hidden = true;
      window.history.replaceState(null, document.title, window.location.pathname);
      message(e?.message || 'Could not verify the reset link. Please request a new one.', 'error');
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!verified || !auth) return;
    const password = $('newPassword').value;
    const confirm = $('confirmPassword').value;
    if (password.length < 8 || password.length > 128) {
      message('Use a password between 8 and 128 characters.', 'error');
      return;
    }
    if (password !== confirm) {
      message('The two passwords do not match.', 'error');
      return;
    }
    save.disabled = true;
    message('Saving your new password…');
    try {
      const result = await auth.updateUser({ password });
      if (result.error) throw result.error;
      verified = false;
      form.reset();
      resetNewToggle();
      resetConfirmToggle();
      form.hidden = true;
      message('Password updated successfully. Return to V200 Diagnostic and sign in using your new password. Your existing purchases are preserved.', 'success');
      try { await auth.signOut({ scope: 'local' }); } catch (_) {}
    } catch (error) {
      message(error?.message || 'The password could not be updated. Please try again.', 'error');
    } finally {
      save.disabled = false;
    }
  });
  start();
})();
