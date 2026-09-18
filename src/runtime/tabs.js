/**
 * uncage-runtime: tabs
 *
 * Webflow's .w-tabs component. Confirmed live (tripora): properly
 * accessible markup -- each tab link is `role="tab"` with
 * `aria-controls` pointing at its panel and `aria-selected` tracking
 * state, styled active/inactive via Webflow's own `w--current` (tab
 * link) / `w--tab-active` (pane) convention classes, which the
 * captured CSS already has real rules for. This only needs to toggle
 * those states on click -- the visual styling is already correct in
 * the page's own CSS.
 */
(function () {
  'use strict';

  function setupGroup(tabLinks) {
    for (var i = 0; i < tabLinks.length; i++) {
      (function (link) {
        link.addEventListener('click', function (event) {
          var targetId = link.getAttribute('aria-controls');
          if (!targetId) return;
          event.preventDefault();
          for (var j = 0; j < tabLinks.length; j++) {
            var other = tabLinks[j];
            var isActive = other === link;
            other.classList.toggle('w--current', isActive);
            other.setAttribute('aria-selected', String(isActive));
            var otherPaneId = other.getAttribute('aria-controls');
            var otherPane = otherPaneId ? document.getElementById(otherPaneId) : null;
            if (otherPane) {
              otherPane.classList.toggle('w--tab-active', isActive);
              otherPane.style.display = isActive ? '' : 'none';
            }
          }
        });
      })(tabLinks[i]);
    }
  }

  function init() {
    var menus = document.querySelectorAll('.w-tab-menu, [role="tablist"]');
    for (var i = 0; i < menus.length; i++) {
      var links = menus[i].querySelectorAll('.w-tab-link, [role="tab"]');
      if (links.length) setupGroup(Array.prototype.slice.call(links));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
