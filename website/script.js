/* ============================================================
   Blueprint — Marketing site behaviour
   Vanilla JS only. No dependencies. Progressive enhancement:
   everything degrades gracefully if JS is unavailable.

   Features
   --------------------------------------------------------------
   1. Scroll-reveal animations (IntersectionObserver)
   2. Sticky-nav "scrolled" state
   3. Mobile menu toggle (accessible)
   4. Smooth in-page anchor scrolling + menu close
   5. Dynamic footer year
   6. Respects prefers-reduced-motion
   ============================================================ */

(function () {
  "use strict";

  // Single source of truth for the user's motion preference.
  var prefersReducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  /* ----------------------------------------------------------
     1. SCROLL-REVEAL
     Reveal elements as they enter the viewport. If the browser
     lacks IntersectionObserver, or the user prefers reduced
     motion, show everything immediately.
  ---------------------------------------------------------- */
  function initReveal() {
    var revealEls = document.querySelectorAll(".reveal");

    // Fallback / reduced-motion: just make everything visible.
    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      revealEls.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          // Stagger siblings slightly for a polished cascade.
          var siblings = Array.prototype.slice.call(
            el.parentNode ? el.parentNode.querySelectorAll(":scope > .reveal") : [el]
          );
          var index = Math.max(0, siblings.indexOf(el));
          el.style.transitionDelay = Math.min(index * 70, 350) + "ms";
          el.classList.add("is-visible");
          obs.unobserve(el); // reveal once, then stop watching
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );

    revealEls.forEach(function (el) { observer.observe(el); });
  }

  /* ----------------------------------------------------------
     2. STICKY-NAV STATE
     Add a frosted background once the page is scrolled.
     rAF-throttled to avoid layout thrash on scroll.
  ---------------------------------------------------------- */
  function initNavScroll() {
    var nav = document.getElementById("nav");
    if (!nav) return;

    var ticking = false;
    function update() {
      nav.classList.toggle("is-scrolled", window.scrollY > 12);
      ticking = false;
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }

    update(); // set correct state on load (e.g. refreshed mid-page)
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ----------------------------------------------------------
     3. MOBILE MENU
     Accessible toggle: manages [hidden], aria-expanded and the
     animated hamburger. Closes on Escape and outside click.
  ---------------------------------------------------------- */
  function initMobileMenu() {
    var toggle = document.getElementById("navToggle");
    var menu = document.getElementById("mobileMenu");
    if (!toggle || !menu) return;

    function openMenu() {
      menu.hidden = false;
      // Force reflow so the display change registers before the class.
      void menu.offsetHeight;
      menu.classList.add("is-open");
      toggle.setAttribute("aria-expanded", "true");
    }
    function closeMenu() {
      menu.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      menu.hidden = true;
    }
    function isOpen() {
      return toggle.getAttribute("aria-expanded") === "true";
    }

    toggle.addEventListener("click", function () {
      isOpen() ? closeMenu() : openMenu();
    });

    // Close when a link inside the menu is chosen.
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) closeMenu();
    });

    // Close on Escape for keyboard users.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) {
        closeMenu();
        toggle.focus();
      }
    });

    // Close when clicking outside the nav.
    document.addEventListener("click", function (e) {
      if (!isOpen()) return;
      if (!e.target.closest("#mobileMenu") && !e.target.closest("#navToggle")) {
        closeMenu();
      }
    });

    // If the viewport grows back to desktop, reset the menu state.
    window.addEventListener("resize", function () {
      if (window.innerWidth > 760 && isOpen()) closeMenu();
    });
  }

  /* ----------------------------------------------------------
     4. SMOOTH ANCHOR SCROLLING
     Native CSS handles smooth scroll; here we also move focus to
     the target for accessibility and honour reduced-motion.
  ---------------------------------------------------------- */
  function initSmoothAnchors() {
    document.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener("click", function (e) {
        var id = link.getAttribute("href");
        if (!id || id === "#") return;
        var target = document.querySelector(id);
        if (!target) return;

        e.preventDefault();
        target.scrollIntoView({
          behavior: prefersReducedMotion ? "auto" : "smooth",
          block: "start"
        });

        // Move focus without an extra scroll jump (preventScroll).
        target.setAttribute("tabindex", "-1");
        try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }

        // Keep the URL hash in sync without a second jump.
        if (history.replaceState) history.replaceState(null, "", id);
      });
    });
  }

  /* ----------------------------------------------------------
     5. FOOTER YEAR
  ---------------------------------------------------------- */
  function initYear() {
    var el = document.getElementById("year");
    if (el) el.textContent = String(new Date().getFullYear());
  }

  /* ----------------------------------------------------------
     INIT — run once the DOM is ready.
  ---------------------------------------------------------- */
  function init() {
    initReveal();
    initNavScroll();
    initMobileMenu();
    initSmoothAnchors();
    initYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
