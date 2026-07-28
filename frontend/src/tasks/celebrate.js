// Task completion celebration - the Asana-style flying unicorn the prototype
// had, rebuilt. Fired from TasksContext.toggleComplete so EVERY complete
// circle in the module (Home, My Tasks, list, board, drawer) gets it without
// per-view wiring. Pure DOM + Web Animations API; nothing React needs to know.
//
// The click coordinates come from a passive capture-phase listener (the click
// always lands before toggleComplete runs), so the unicorn takes off from the
// circle the person actually pressed, and the row it sits in gets a green
// sweep - rows opt in via a data-task-row attribute.

let last = { x: null, y: null, target: null };
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (e) => {
    last = { x: e.clientX, y: e.clientY, target: e.target };
  }, true);
}

const GREEN = '#00c875';

export function celebrateCompletion() {
  const x = last.x ?? window.innerWidth / 2;
  const y = last.y ?? window.innerHeight / 2;

  // Green sweep across the task's row, so the state change reads on the row
  // itself before it moves to Completed.
  const row = last.target?.closest?.('[data-task-row]');
  if (row) {
    const prevBg = row.style.background;
    const prevTr = row.style.transition;
    row.style.transition = 'background 0.2s';
    row.style.background = 'rgba(0,200,117,0.22)';
    setTimeout(() => { row.style.background = prevBg; row.style.transition = prevTr; }, 700);
  }

  // Pop the circle button that was pressed.
  const pressed = last.target?.closest?.('button');
  if (pressed?.animate) {
    pressed.style.color = GREEN;
    pressed.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1)' }],
      { duration: 320, easing: 'ease-out' },
    );
  }

  // Expanding green ring at the click point.
  const ring = document.createElement('div');
  ring.style.cssText = `position:fixed;left:${x - 12}px;top:${y - 12}px;width:24px;height:24px;border-radius:50%;border:3px solid ${GREEN};z-index:9998;pointer-events:none;`;
  document.body.appendChild(ring);
  ring.animate(
    [{ transform: 'scale(0.4)', opacity: 0.9 }, { transform: 'scale(2.6)', opacity: 0 }],
    { duration: 550, easing: 'ease-out' },
  ).onfinish = () => ring.remove();

  // The unicorn, flying up and out.
  const uni = document.createElement('div');
  uni.textContent = '🦄';
  uni.style.cssText = `position:fixed;left:${x}px;top:${y}px;font-size:30px;line-height:1;z-index:9999;pointer-events:none;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.25));`;
  document.body.appendChild(uni);
  uni.animate([
    { transform: 'translate(-10px, 6px) scale(0.4) rotate(-10deg)', opacity: 0 },
    { transform: 'translate(30px, -46px) scale(1.2) rotate(4deg)', opacity: 1, offset: 0.35 },
    { transform: 'translate(95px, -110px) scale(1.05) rotate(10deg)', opacity: 1, offset: 0.75 },
    { transform: 'translate(160px, -175px) scale(0.9) rotate(16deg)', opacity: 0 },
  ], { duration: 1200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }).onfinish = () => uni.remove();

  // Sparkle trail behind it.
  const glyphs = ['✨', '⭐', '💫'];
  for (let i = 0; i < 6; i++) {
    const s = document.createElement('div');
    s.textContent = glyphs[i % glyphs.length];
    s.style.cssText = `position:fixed;left:${x}px;top:${y}px;font-size:${12 + (i % 3) * 4}px;line-height:1;z-index:9998;pointer-events:none;`;
    document.body.appendChild(s);
    const dx = 18 + i * 24;
    const dy = -10 - i * 26;
    s.animate([
      { transform: 'translate(0, 0) scale(0.5)', opacity: 0 },
      { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(1)`, opacity: 1, offset: 0.4 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0 },
    ], { duration: 900 + i * 80, delay: i * 55, easing: 'ease-out' }).onfinish = () => s.remove();
  }
}
