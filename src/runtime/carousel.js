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
 *
 * Two Webflow slider animation modes exist (root element's
 * data-animation attribute), and they need genuinely different runtime
 * mechanics, not just different CSS:
 *   - "slide" (default): slides sit side by side in a flex track: the
 *     mask viewport is fixed-width and the track slides underneath it.
 *     Handled below via mask.style.transform = translateX(...).
 *   - "cross" (crossfade): Webflow's own CSS already stacks every slide
 *     in the same position (no flex track, no translate needed at all);
 *     only the active slide's visibility/opacity differs. Confirmed live
 *     (tripora bug report): the captured, settled HTML already carries
 *     inline `visibility: hidden` on every non-active slide (baked in by
 *     the earlier "settle animation states" pass, matching Webflow's own
 *     crossfade resting state) -- driving this the "slide" way instead
 *     scrolled the mask to the right position but left the target slide
 *     still `visibility:hidden` underneath, rendering an empty gap.
 *     Fixed by branching: for "cross" sliders, never touch the mask's
 *     transform/display/flex at all, and instead toggle each slide's own
 *     visibility/opacity directly -- an instant swap, not a timed
 *     crossfade (Webflow's own smooth transition was driven by
 *     webflow.js's easing engine, which this runtime doesn't reproduce;
 *     an instant, correct swap is the safe baseline, matching this
 *     runtime's "functional replacement, not pixel-perfect animation
 *     reproduction" scope everywhere else).
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
    var isCrossfade = root.getAttribute('data-animation') === 'cross';
    var dots = root.querySelectorAll('.w-slider-nav .w-slider-dot');
    var leftArrow = root.querySelector('.w-slider-arrow-left');
    var rightArrow = root.querySelector('.w-slider-arrow-right');

    function render() {
      if (isCrossfade) {
        for (var c = 0; c < slides.length; c++) {
          var active = c === current;
          slides[c].style.visibility = active ? 'visible' : 'hidden';
          slides[c].style.opacity = active ? '1' : '0';
        }
      } else {
        mask.style.transform = 'translateX(' + -current * 100 + '%)';
      }
      for (var i = 0; i < dots.length; i++) {
        var dotActive = i === current;
        dots[i].classList.toggle('w-active', dotActive);
        dots[i].setAttribute('aria-pressed', String(dotActive));
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

    if (!isCrossfade) {
      mask.style.display = 'flex';
      for (var s = 0; s < slides.length; s++) {
        slides[s].style.flex = '0 0 100%';
      }
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
