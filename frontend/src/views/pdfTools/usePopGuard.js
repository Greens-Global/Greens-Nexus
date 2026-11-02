// The browser's Back and Forward with unsaved work in PDF Tools. App.jsx's
// navigate() asks first, but its popstate listener moves straight away, and with a
// document open Back is the one way out still on screen (the editor covers the
// sidebar and the header). So while there is work to lose this listens ahead of
// App, in the capture phase: put the address back, ask, then go if they say so.
//
// A pop to this same path is a popup's own history entry (lib/useBackToClose.js),
// and is left alone.
import { useEffect } from 'react';
import { askToLeave, setInlineDirty } from '../../lib/dialogGuard';

export default function usePopGuard(dirty, key = 'pdf-tools') {
  useEffect(() => {
    if (!dirty) return undefined;
    const home = window.location.pathname;
    const homeDepth = window.history.state?.depth || 0;
    let restoring = false;
    let leaving = false;
    const onPop = (e) => {
      if (leaving) return;
      if (restoring) {
        restoring = false;
        e.stopImmediatePropagation();
        return;
      }
      if (window.location.pathname === home) return;
      e.stopImmediatePropagation();
      const back = (homeDepth - (e.state?.depth || 0)) || 1;
      restoring = true;
      window.history.go(back);
      askToLeave().then((ok) => {
        if (!ok) return;
        leaving = true;
        setInlineDirty(key, false);
        window.history.go(-back);
      });
    };
    window.addEventListener('popstate', onPop, true);
    return () => window.removeEventListener('popstate', onPop, true);
  }, [dirty, key]);
}
