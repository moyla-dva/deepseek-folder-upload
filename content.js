(function () {
  'use strict';

  const shared = window.__dfsShared;
  if (!shared || typeof shared.mountUI !== 'function') return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', shared.mountUI);
  } else {
    shared.mountUI();
  }
})();
