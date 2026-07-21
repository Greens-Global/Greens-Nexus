// ── Silent multi-monitor capture ──────────────────────────────────────────────
// Electron's desktopCapturer is a NATIVE API — it does NOT trigger Chrome's
// "sharing your screen" indicator (that only appears for getDisplayMedia in a
// web page). getSources with types:['screen'] returns one source per physical
// display, so a two-monitor machine yields two frames per pass automatically.

const { desktopCapturer } = require('electron');
const config = require('./config');

async function captureAllScreens() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    // Bounding box; each thumbnail is scaled to fit while keeping aspect ratio.
    thumbnailSize: { width: config.maxWidth, height: config.maxWidth },
    fetchWindowIcons: false,
  });
  return sources
    .filter(s => !s.thumbnail.isEmpty())
    .map((s, i) => ({
      index: i + 1,
      total: sources.length,
      jpeg: s.thumbnail.toJPEG(config.jpegQuality),
    }));
}

module.exports = { captureAllScreens };
