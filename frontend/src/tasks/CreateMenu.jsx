// Task Module - the create control, in two shapes over one menu.
//
// Was a "+ Create" dropdown in a bar of its own above the page header (with a
// mobile-only FAB variant). That bar held two controls and cost a whole row on
// every page, so the row was merged into each page's header and the create
// action became a floating button (Sagar, Sept 1 2026).
//
//   variant="inline" - the labeled "+ Create" in the module bar, next to
//                      Manage. It carries the WHOLE menu, so anything in the
//                      module can be started from any screen.
//   variant="fab"    - the floating "+", bottom-right. Given `create` it is a
//                      single action - what THIS page is a list of: Project on
//                      Projects, Portfolio on Portfolios, Team on Teams,
//                      Template on Templates, Task everywhere else (Sagar,
//                      Sept 1 2026). Without `create` it opens the same menu
//                      the inline button does.
//
// One ITEMS list drives both, so a new create target is added once and appears
// in the menu and as a page's floating action. In the menu-shaped FAB the
// button IS the state: "+" rotates 45 degrees into "x" while the options are
// open, so one control both opens and closes the menu and its current meaning
// is legible without a label.
import { useEffect, useRef, useState } from 'react';
import { Plus, ListChecks, FolderKanban, Briefcase, FilePlus } from 'lucide-react';
import { NX, FONT, btn } from './theme';
import CreateTaskModal from './CreateTaskModal';
import { ProjectCreateModal } from './ProjectsView';
import { PortfolioCreateModal } from './PortfoliosView';
import { SaveTemplateModal } from './TemplatesView';

// Each page's own create modal, reused - not re-implemented here. This menu
// decides WHEN to open one; the screen that owns the thing decides what the
// form asks for, so the two can never drift apart.
// A team is made from Manage - Teams, not from here (Sagar, Sept 2 2026), and
// "From Template" was a browse rather than a create: the Templates screen it
// went to is one click away on Projects.
const ITEMS = [
  { key: 'task', label: 'Task', icon: ListChecks },
  { key: 'project', label: 'Project', icon: FolderKanban },
  { key: 'portfolio', label: 'Portfolio', icon: Briefcase },
  { key: 'template', label: 'Template', icon: FilePlus },
];
const ITEM = Object.fromEntries(ITEMS.map((i) => [i.key, i]));

// `bottom` is supplied by the module shell, which stacks this above the
// "Report a Bug" pill from a single base offset - see Tasks.jsx's fabBottom.
const FAB_RIGHT = 16;
const FAB_SIZE = 56;

export default function CreateMenu({ onNavigate, taskDefaults = {}, bottom = 60, variant = 'fab', create = '' }) {
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(null); // an ITEMS key, or null
  const ref = useRef(null);
  // A page-scoped FAB: one action, fired on click - no menu to open, so the
  // "+" never turns into an "x".
  const single = variant === 'fab' && ITEM[create] ? ITEM[create] : null;

  // Escape closes, like every other dismissible layer in the module. The scrim
  // below handles pointer dismissal, so there is no outside-click listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const inline = variant === 'inline';
  const pick = (key) => { setOpen(false); setShow(key); };

  return (
    // Inline anchors its dropdown to itself, so it needs a positioned box; the
    // FAB positions itself against the viewport and must not create one.
    <div ref={ref} style={inline ? { position: 'relative', flexShrink: 0 } : undefined}>
      {/* Catches the click that closes the menu, and separates the options from
          the page behind them. Transparent enough that the page is still read
          as present rather than replaced - this is a menu, not a modal.
          Inline's scrim is clear: a header dropdown this small tinting the
          whole page reads as a modal opening, which it isn't. */}
      {open && !single && (
        <div onClick={() => setOpen(false)} aria-hidden="true" style={{
          position: 'fixed', inset: 0, zIndex: 2490, background: inline ? 'transparent' : 'rgba(23,26,38,0.10)',
        }} />
      )}

      {open && !single && (inline ? (
        /* Standard module dropdown panel (same anatomy as Home's range picker
           and the project pickers) rather than the FAB's floating pills - in a
           bar, a stack of shadowed pills would read as detached from the
           button that opened it. Right-aligned: the button sits at the bar's
           right end, so a left-aligned panel would hang off the edge. */
        <div role="menu" aria-label="Create" style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, width: 190, zIndex: 2600,
          background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4,
        }}>
          {ITEMS.map(({ key, label: l, icon: Icon }) => (
            <button key={key} role="menuitem" onClick={() => pick(key)}
              style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 9 }}
            ><Icon size={15} style={{ color: NX.primary, flexShrink: 0 }} /> {l}</button>
          ))}
        </div>
      ) : (
        <div role="menu" aria-label="Create" style={{
          position: 'fixed', right: FAB_RIGHT, bottom: bottom + FAB_SIZE + 12, zIndex: 2600,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
        }}>
          {ITEMS.map(({ key, label: l, icon: Icon }, i) => (
            <button key={key} role="menuitem" className="nx-fab-item"
              onClick={() => pick(key)}
              // Staggered from the button outwards, so the menu reads as coming
              // OUT of the "+" rather than appearing all at once.
              style={{ animationDelay: `${(ITEMS.length - 1 - i) * 40}ms` }}
            ><Icon size={16} style={{ color: NX.primary, flexShrink: 0 }} /> {l}</button>
          ))}
        </div>
      ))}

      {inline ? (
        <button onClick={() => setOpen((o) => !o)}
          aria-expanded={open} aria-haspopup="menu" title="Create"
          style={{ ...btn('primary'), flexShrink: 0, whiteSpace: 'nowrap', position: 'relative', zIndex: 2600 }}>
          <Plus size={15} /> <span className="nx-btn-label">Create</span>
        </button>
      ) : (
        <button onClick={() => (single ? pick(single.key) : setOpen((o) => !o))} className="nx-fab"
          aria-expanded={single ? undefined : open} aria-haspopup={single ? undefined : 'menu'}
          title={single ? `New ${single.label}` : (open ? 'Close' : 'Create')}
          aria-label={single ? `New ${single.label}` : (open ? 'Close create menu' : 'Create')}
          style={{
            position: 'fixed', right: FAB_RIGHT, bottom, zIndex: 2600,
            width: FAB_SIZE, height: FAB_SIZE, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: NX.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: FONT, padding: 0,
          }}>
          {/* One icon, rotated - not two icons swapped. The 45 degree turn IS the
              + becoming an x, so the control never blinks between two glyphs. */}
          <Plus size={26} style={{ transform: open ? 'rotate(45deg)' : 'none' }} className="nx-fab-icon" />
        </button>
      )}

      {show === 'task' && <CreateTaskModal defaults={taskDefaults} onClose={() => setShow(null)} lockedProjectId={taskDefaults.projectId || ''} />}

      {show === 'project' && (
        <ProjectCreateModal onClose={() => setShow(null)} onCreated={() => onNavigate && onNavigate('projects')} />
      )}

      {show === 'portfolio' && (
        <PortfolioCreateModal onClose={() => setShow(null)} onCreated={() => onNavigate && onNavigate('portfolios')} />
      )}

      {/* The Templates screen's own "New Template" form, so the two entry
          points ask for exactly the same thing. */}
      {show === 'template' && (
        <SaveTemplateModal onClose={() => setShow(null)} onSaved={() => onNavigate && onNavigate('templates')} />
      )}

    </div>
  );
}
