/* Loroco docs — theme switch.
 *
 * Loaded synchronously in <head>, so the data-theme attribute is set
 * before the first paint and there is no flash of the wrong theme.
 * The resolved theme is: an explicit user choice (localStorage) if
 * present, otherwise the operating system's prefers-color-scheme.
 * Only the CSS variables differ between themes — see styles.css. */
(function () {
  "use strict";

  var KEY = "loroco-theme";
  var root = document.documentElement;
  var media = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  function savedChoice() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "dark" || v === "light" ? v : null;
    } catch (e) {
      return null;
    }
  }

  function systemTheme() {
    return media && media.matches ? "dark" : "light";
  }

  function apply(theme) {
    root.dataset.theme = theme;
    var btn = document.querySelector(".nav-theme");
    if (btn) btn.setAttribute("aria-pressed", String(theme === "dark"));
  }

  // 1. Resolve and apply immediately (runs at <head> parse time).
  apply(savedChoice() || systemTheme());

  // 2. Follow OS changes while the user hasn't made an explicit choice.
  if (media) {
    var onSystemChange = function () {
      if (!savedChoice()) apply(systemTheme());
    };
    if (media.addEventListener) media.addEventListener("change", onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  // 3. Wire the toggle once the nav exists.
  function wire() {
    var btn = document.querySelector(".nav-theme");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(root.dataset.theme === "dark"));
    btn.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {
        /* private mode — choice just won't persist */
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
