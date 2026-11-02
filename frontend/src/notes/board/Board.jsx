// TASK C STUB of the whiteboard engine wrapper. Task A builds the real
// Board.jsx (Excalidraw, self-hosted, lazy `vendor-excalidraw` chunk) with
// exactly these props; this file exists so the Notes UI compiles and its
// tests run before the engine lands. Delete at merge in favor of Task A's.
//
// Props (plan, Interfaces): note, isPhone, look, onLook, onScene, onThumb,
// collab, onApi.
export default function Board({ note, isPhone = false, look = 'clean', onLook, onScene, onThumb, collab, onApi }) {
  void onLook; void onScene; void onThumb; void collab; void onApi;
  return (
    <div className="nt-board-stub" data-testid="board-stub" data-look={look} data-phone={isPhone ? 'true' : undefined} data-can-edit={note?.canEdit ? 'true' : 'false'}
      style={{ flex: '1 1 auto', minHeight: 320, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 13 }}>
      The whiteboard is loading.
    </div>
  );
}
