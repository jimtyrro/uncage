/**
 * uncage-runtime: nav-dropdown
 *
 * Webflow's mobile nav ("hamburger") and general dropdown-menu component.
 * Targets .w-nav-button / .w-dropdown-toggle plus the more general
 * aria-controls + aria-expanded pattern Webflow's own accessible markup
 * already uses (confirmed live on tripora: the hamburger button carries
 * aria-controls="w-nav-overlay-0" pointing at the panel, aria-expanded
 * tracking open/closed state).
 *
 * One real wrinkle, confirmed live: the target panel Webflow's hamburger
 * points to (.w-nav-overlay) ships EMPTY in the captured HTML -- Webflow's
 * own runtime clones the real menu content (the sibling .w-nav-menu) into
 * it on first open, rather than having it statically present. This
 * reproduces that: clones the real menu into an empty target once, then
 * just toggles visibility on subsequent opens. The panel's own captured
 * CSS already defines display:none as its closed state (confirmed:
 * `.w-nav-overlay{display:none;...}` is Webflow's own default rule, not
 * something this module needs to invent) -- this only needs to flip
 * `display` on click, matching Webflow's own simple mechanism.
 */
(function () {
  'use strict';

  function findMenuSource(toggle) {
    // The real menu content usually lives as a sibling of the toggle
    // button, inside the same nav bar wrapper.
    var scope = toggle.closest('.w-nav') || toggle.parentElement;
    return scope ? scope.querySelector('.w-nav-menu') : null;
  }

  function setupToggle(toggle) {
    var targetId = toggle.getAttribute('aria-controls');
    var target = targetId ? document.getElementById(targetId) : null;
    if (!target) {
      // .w-dropdown-toggle's sibling .w-dropdown-list, the general
      // (non-nav) dropdown component's own convention.
      var scope = toggle.closest('.w-dropdown');
      target = scope ? scope.querySelector('.w-dropdown-list') : null;
    }
    if (!target) return;

    var cloned = false;
    toggle.addEventListener('click', function () {
      var isOpen = toggle.getAttribute('aria-expanded') === 'true';
      if (!isOpen && !cloned && target.children.length === 0) {
        var source = findMenuSource(toggle);
        if (source) {
          target.innerHTML = source.innerHTML;
          cloned = true;
        }
      }
      var next = !isOpen;
      toggle.setAttribute('aria-expanded', String(next));
      target.style.display = next ? 'block' : 'none';
    });
  }

  function init() {
    var toggles = document.querySelectorAll(
      '.w-nav-button, .w-dropdown-toggle, [aria-haspopup="true"], [aria-haspopup="menu"]'
    );
    for (var i = 0; i < toggles.length; i++) setupToggle(toggles[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
