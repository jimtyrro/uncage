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
 * data-animation attribute), and both need the mask's flex-track
 * transform -- the actual difference is a visibility/opacity layer on
 * top, not a different positioning mechanism:
 *   - "slide" (default): slides sit side by side in a flex track, the
 *     mask viewport is fixed-width, and the track slides underneath it
 *     via mask.style.transform = translateX(...). No visibility/opacity
 *     toggling -- every slide stays visible, you just see whichever one
 *     the transform currently scrolls into view.
 *   - "cross" (crossfade): still the same flex track and the same
 *     transform (confirmed live on tripora after an initial wrong
 *     assumption -- see below), PLUS each slide's own visibility/opacity
 *     toggled so only the active one shows.
 *
 * This took two real-data corrections to get right, both from tripora's
 * `.location-slider` (data-animation="cross"):
 *   1. Bare mask-transform alone (no branch at all) left the target
 *      slide's own captured `visibility: hidden` in place (baked in by
 *      the earlier "settle animation states" pass, matching Webflow's
 *      own crossfade resting state) -- transform scrolled to the right
 *      position, but the content there was still invisible.
 *   2. The first fix for that assumed "cross" meant slides are
 *      absolutely stacked in place (no flex track, no transform needed
 *      at all) and skipped the transform/flex setup entirely for
 *      "cross" sliders. Wrong: tripora's captured markup keeps "cross"
 *      sliders in the exact same flex row as "slide" sliders --
 *      confirmed live, mask.style.display stayed "flex" either way, and
 *      each .w-slide is a normal flex item at its own row position, not
 *      absolutely positioned. Skipping the transform left the
 *      now-correctly-visible target slide sitting at its natural flex
 *      offset, almost entirely outside the mask's overflow:hidden
 *      viewport -- functionally still broken, just a different visible
 *      symptom (a sliver of the wrong edge peeking in, worsening with
 *      each click, instead of a blank gap).
 *
 * Both real bugs are fixed by treating "cross" as "slide" plus a
 * visibility/opacity layer, not as a different positioning mechanism:
 * flex/transform setup always runs, and only the crossfade-specific
 * visibility/opacity toggle is conditional. The toggle is an instant
 * swap, not a timed crossfade (Webflow's own smooth transition was
 * driven by webflow.js's easing engine, which this runtime doesn't
 * reproduce; an instant, correct swap is the safe baseline, matching
 * this runtime's "functional replacement, not pixel-perfect animation
 * reproduction" scope everywhere else).
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
      mask.style.transform = 'translateX(' + -current * 100 + '%)';
      if (isCrossfade) {
        for (var c = 0; c < slides.length; c++) {
          var active = c === current;
          slides[c].style.visibility = active ? 'visible' : 'hidden';
          slides[c].style.opacity = active ? '1' : '0';
        }
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
