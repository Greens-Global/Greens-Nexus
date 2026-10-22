// Accounting defaults chosen while an open question waits on Charmi. Each is
// a named value here and nowhere else - the screens import it, so a different
// answer is a one-line change. The server's own defaults are in
// backend/accounting_assumptions.py.

// ── CR-13: AMA (Ask My Accountant) ─────────────────────────────────────────

// CR-13 (Charmi to confirm): an entry with more than two lines (a bank-feed
// batch, a split) has several accounts on the other side - chosen 'largest'
// (the biggest one, with "+N more" and the full list on hover and in the
// panel) because one account per row keeps the grid readable and the bank or
// card a withdrawal came from is almost always the biggest line. 'all' lists
// every one in the cell.
export const AMA_OFFSET_DISPLAY = 'largest';

// CR-13 (Charmi to confirm): keep the Account column next to Other Side?
// Chosen false - on the AMA list it always reads "63501 ? Ask My Accountant"
// (Charmi, 36:07: "I don't care if the Ask My Accountant doesn't show up");
// the account still shows in the side panel and above the grid. true puts it
// back beside Other Side.
export const AMA_SHOW_ACCOUNT_COLUMN = false;

// CR-13: how many entries one "other side" read asks for (the server caps it
// at AMA_OFFSET_BATCH_MAX = 100 in backend/accounting_assumptions.py).
export const AMA_OFFSET_BATCH = 100;

// CR-13: how many GL accounts the picker lists at once while typing.
export const AMA_GL_PICKER_LIMIT = 60;
