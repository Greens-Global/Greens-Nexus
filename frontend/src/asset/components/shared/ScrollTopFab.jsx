import { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

/** Floating back-to-top button; appears once the page has scrolled past 360px. Uses the CSS
 *  class `.scrolltop-fab` (already defined in styles.css) for positioning/appearance. The
 *  original renders a chevron-down icon rotated 180deg rather than importing a separate up-arrow icon. */
export function ScrollTopFab() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 360);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      className="scrolltop-fab"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      title="Back to top"
      aria-label="Back to top"
    >
      <ChevronDown size={20} style={{ transform: 'rotate(180deg)' }} />
    </button>
  );
}
