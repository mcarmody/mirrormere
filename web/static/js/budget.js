/**
 * Mirrormere weekly budget bar. Sits in the header beside the weather badge.
 * Reads static/budget.json (pushed by the desktop every 15 minutes) and re-reads it every 15 minutes.
 */
(() => {
  const REFRESH_MS = 15 * 60 * 1000;
  let fill = null;
  let label = null;

  function mount() {
    const weather = document.getElementById('header-weather');
    if (!weather || document.getElementById('header-budget')) return;
    const wrap = document.createElement('div');
    wrap.id = 'header-budget';
    wrap.className = 'header-budget';
    wrap.innerHTML =
      '<span class="budget-label" id="budget-label">WEEK --%</span>' +
      '<span class="budget-track"><span class="budget-fill" id="budget-fill"></span></span>';
    weather.insertAdjacentElement('afterend', wrap);
    fill = wrap.querySelector('#budget-fill');
    label = wrap.querySelector('#budget-label');
  }

  async function refresh() {
    try {
      const res = await fetch('static/budget.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      const pct = Math.max(0, Math.min(100, Number(d.pct)));
      if (!Number.isFinite(pct)) return;
      fill.style.width = pct + '%';
      label.textContent = 'WEEK ' + Math.round(pct) + '%';
    } catch (_) { /* keep the last value */ }
  }

  function start() {
    mount();
    if (!fill) return;
    refresh();
    setInterval(refresh, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
