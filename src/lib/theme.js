/**
 * Cert Buddy shared design tokens for content-script shadow-DOM CSS.
 *
 * tagger.js's launcher/panel and outcomes.js's confidence toast each render
 * inside their own shadow root, so each needs its own copy of the same
 * :host custom-property palette (light + dark) plus the shared box-sizing /
 * font reset. This is that shared block, composed as
 * `CertBuddyTheme.css + <caller's own rules>` by both.
 *
 * popup.css (the popup/dashboard's regular, non-shadow stylesheet) is NOT
 * wired to this — a no-build extension has no plumbing to share a token
 * block between a shadow-DOM template string and a linked stylesheet. Its
 * :root block is a hand-kept COPY of these same values: if you touch a
 * token here, update popup.css's :root to match.
 *
 * Loaded before adapters.js (which tagger.js/outcomes.js in turn depend on)
 * in the manifest's content_scripts list, in popup.html's script order, and
 * in popup.js's on-demand injection file list.
 */
(function (root) {
  const css = `
    :host {
      all: initial;
      --bg: #fafbf9;
      --raised: #ffffff;
      --line: #e2e7e3;
      --fg: #14171a;
      --muted: #6b7480;
      --accent: #149463;
      --accent-ink: #ffffff;
      --danger: #c73f52;
      --warn: #b07a1e;
      --warn-ink: #ffffff;
      --mono: ui-monospace, "SF Mono", Menlo, monospace;
      --radius: 8px;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #0e1210;
        --raised: #161b18;
        --line: #242b27;
        --fg: #e6e9ee;
        --muted: #98a1ad;
        --accent: #3ddc97;
        --accent-ink: #062018;
        --danger: #ff7b8a;
        --warn: #e8c37a;
        --warn-ink: #2b2210;
      }
    }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  `;

  /**
   * Shared fullscreen ride-along, used identically by tagger.js's
   * panel/launcher host and outcomes.js's toast host.
   *
   * Element-fullscreen (a study site's own "expand" control, e.g. Udemy's)
   * renders ONLY the fullscreened subtree — UI mounted outside it silently
   * disappears. Call once per host right after creating it: this does the
   * initial mount-into-fullscreen-if-already-fullscreened check (covers
   * on-demand injection landing mid-exam) AND wires the fullscreenchange
   * listener that re-parents the host in on the way into fullscreen and back
   * out to documentElement on the way out.
   */
  function mountFullscreenAware(host) {
    (document.fullscreenElement || document.documentElement).appendChild(host);
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement;
      if (fs && !fs.contains(host)) fs.appendChild(host);
      else if (!fs && host.parentElement !== document.documentElement) {
        document.documentElement.appendChild(host);
      }
    });
  }

  root.CertBuddyTheme = { css, mountFullscreenAware };
})(globalThis);
