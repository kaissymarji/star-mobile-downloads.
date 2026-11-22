/* V200 password recovery: preserve the verified recovery callback across pages. */
(function () {
  'use strict';
  const qs = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (qs.get('type') !== 'recovery' && hash.get('type') !== 'recovery') return;
  if (/\/reset-password\.html$/.test(window.location.pathname)) return;
  const destination = new URL('reset-password.html', window.location.href);
  destination.search = window.location.search;
  destination.hash = window.location.hash;
  window.location.replace(destination.href);
})();
