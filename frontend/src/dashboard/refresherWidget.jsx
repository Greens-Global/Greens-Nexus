// The Dashboard's Refresher tile (Neil, 11/07/2026), in a chunk of its own.
//
// The Refresher draws with the Knowledge Base's styles (kb.css, scoped under
// .kb), which used to load only with the Knowledge Base itself: on a board
// opened first thing - every phone - the tile was bare text with no card
// (11/17/2026 phone pass). The stylesheet now comes with the tile, and only
// when a board carries one.
import '../kb/kb.css';
import Refresher from '../kb/training/Refresher';

export default function RefresherWidget() {
  return <div className="kb" style={{ height: '100%' }}><Refresher compact /></div>;
}
