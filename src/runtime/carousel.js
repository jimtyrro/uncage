/**
 * uncage-runtime: carousel
 *
 * Webflow's .w-slider component. Confirmed live (tripora): a
 * .w-slider-mask "viewport" containing N .w-slide children, paired with
 * .w-slider-arrow-left/-right (aria-controls pointing at the mask) and a
 * .w-slider-nav containing one .w-slider-dot per slide (the current one
 * marked .w-active). This drives the same mechanism Webflow's own JS
 * does -- translateX the mask's slide track by index -- rather than
 * anything visually different, so it matches the original site's own
 * layout exactly.
 *
 * Scoped to the Webflow pattern specifically (stable, documented
 * classes). Framer's own slideshow component has no equivalent stable
 * structure to key off of and was confirmed rare in practice (a single
 * instance across all locally captured projects this was developed
 * against) -- not attempted here to avoid shipping an unverified
 * reimplementation for a low-frequency case.
 */
(function () {
  'use strict';

  function setupSlider(root) {
    var mask = root.querySelector('.w-slider-mask');
    if (!mask) return;
    var slides = Array.prototype.slice.call(mask.children).filter(function (c) {
      return c.classList.contains('w-slide');
    });
    if (slides.length < 2) return;

    var current = 0;
    var infinite = root.getAttribute('data-infinite') !== 'false';
    var dots = root.querySelectorAll('.w-slider-nav .w-slider-dot');
    var leftArrow = root.querySelector('.w-slider-arrow-left');
    var rightArrow = root.querySelector('.w-slider-arrow-right');

    function render() {
      mask.style.transform = 'translateX(' + -current * 100 + '%)';
      for (var i = 0; i < dots.length; i++) {
        var active = i === current;
        dots[i].classList.toggle('w-active', active);
        dots[i].setAttribute('aria-pressed', String(active));
      }
    }

    function goTo(index) {
      if (infinite) {
        current = ((index % slides.length) + slides.length) % slides.length;
      } else {
        current = Math.max(0, Math.min(slides.length - 1, index));
      }
      render();
    }

    if (leftArrow) leftArrow.addEventListener('click', function () { goTo(current - 1); });
    if (rightArrow) rightArrow.addEventListener('click', function () { goTo(current + 1); });
    for (var d = 0; d < dots.length; d++) {
      (function (index) {
        dots[index].addEventListener('click', function () { goTo(index); });
      })(d);
    }

    mask.style.display = 'flex';
    for (var s = 0; s < slides.length; s++) {
      slides[s].style.flex = '0 0 100%';
    }
    render();
  }

  function init() {
    var sliders = document.querySelectorAll('.w-slider');
    for (var i = 0; i < sliders.length; i++) setupSlider(sliders[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
