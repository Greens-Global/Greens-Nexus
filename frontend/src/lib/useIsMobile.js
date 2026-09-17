// The app's phone breakpoint, as a hook.
//
// This lived in tasks/components.jsx, which is a 45 KB chunk. The Documents
// module needed the same 10 lines for the Document Builder's phone layout, and
// importing it from there would have made every document editor session
// download the Tasks component library - and coupled two modules that had no
// other link between them. The implementation moved here; tasks/components.jsx
// re-exports it, so there is still exactly one of it.
import { useState, useEffect } from 'react';

export function useIsMobile(query = '(max-width: 640px)') {
  const [match, setMatch] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatch(e.matches);
    setMatch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}
