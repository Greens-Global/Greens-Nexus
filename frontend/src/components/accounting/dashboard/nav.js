import { createContext, useContext } from 'react';

/** Where a widget's link goes: another dashboard tab, or the Reports tab. Provided by Accounting.jsx.
 * Its own file (11/11/2026) so the Accounting view can provide it without importing the widget
 * registry, which pulls the charts library into every Accounting screen. */
// `can(to)`: whether this person may open that screen - a Set Up link to one they cannot is not drawn.
export const DashNav = createContext(() => {});
export const useDashNav = () => useContext(DashNav);
