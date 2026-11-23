// Applies the saved colour theme before first paint, so true-black users never see a flash.
// External (not inline) because the Content-Security-Policy forbids inline scripts.
(function () {
  try {
    var t = localStorage.getItem('outpost.theme');
    if (t === 'dark' || t === 'black' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage unavailable: keep the default (black) */
  }
})();
