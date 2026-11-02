// The board when the drawing tools are not here (Neil, 11/02/2026): the
// engine's chunk did not load (a deploy swapped the files under an open tab,
// the CSP, offline) or the engine threw while drawing. The board is never
// blank and never throws to the page's error boundary: it shows its last
// saved picture (the note's thumbnail) full width, read-only, says so, and
// offers Retry - which imports the engine again (a failed load is not
// remembered, see ./index.js).
import { Component } from 'react';
import { PenTool, RefreshCw } from 'lucide-react';
import { SkeletonBlocks } from '../../../components/AsyncState';

export default function BoardFallback({ note, onRetry, busy = false }) {
  const thumb = note?.thumbUrl || note?.thumb_url || '';
  const title = note?.title || 'Untitled Board';
  return (
    <div className="nx-board-fallback" data-testid="nx-board-fallback">
      {thumb
        ? <img className="nx-board-fallback-pic" src={thumb} alt={`${title} - the last saved picture`} />
        : (
          <div className="nx-board-fallback-empty">
            <PenTool size={28} aria-hidden="true" />
            <span>No picture of this board yet.</span>
          </div>
        )}
      <div className="nx-board-fallback-bar" role="status">
        <span>The drawing tools did not load.</span>
        <button type="button" className="nx-board-fallback-retry" onClick={onRetry} disabled={busy}>
          <RefreshCw size={14} aria-hidden="true" />
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    </div>
  );
}

/** While the engine's chunk is on its way: a skeleton, never nothing. */
export function BoardLoading() {
  return <div className="nx-board-loading"><SkeletonBlocks count={3} height={90} /></div>;
}

/** An engine crash while drawing stays inside the board: the fallback shows
 *  (with the picture) and Retry mounts the engine again. */
export class EngineBoundary extends Component {
  state = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(err) { this.props.onCrash?.(err); }
  retry = () => { this.setState({ crashed: false }); this.props.onRetry?.(); };
  render() {
    return this.state.crashed ? <BoardFallback note={this.props.note} onRetry={this.retry} /> : this.props.children;
  }
}
