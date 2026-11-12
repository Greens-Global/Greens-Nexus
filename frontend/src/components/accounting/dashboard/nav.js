import { createContext, useContext } from 'react';

/** Where a widget's link goes: another dashboard tab, or the Reports tab. Provided by Accounting.jsx.
 * Its own file (11/11/2026) so the Accounting view can provide it without importing the widget
 * registry, which pulls the charts library into every Accounting screen. */
export const DashNav = createContext(() => {});
export const useDashNav = () => useContext(DashNav);
