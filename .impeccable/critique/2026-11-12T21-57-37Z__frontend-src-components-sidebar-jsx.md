---
target: "navigation: top header and left rail"
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-11-12T21-57-37Z
slug: frontend-src-components-sidebar-jsx
---
Method: dual-agent (A: design review · B: detector + browser evidence)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Rail rows show no counts (Tickets had 1 needing reply); phone header never names the page |
| 2 | Match System / Real World | 3 | "Operations" is both a group and a module in it; overflow called "More" and "Other Queues" |
| 3 | User Control and Freedom | 2 | Back line cut to "← Da…"; any outside click folds the rail |
| 4 | Consistency and Standards | 2 | Two focus-ring colors; dark-mode active pill is cobalt; Clocked Out red folded, gray open; search moves between modules at 1280 |
| 5 | Error Prevention | 3 | First click on a header overflow menu is eaten while the rail is open |
| 6 | Recognition Rather Than Recall | 2 | Folded rail = 19 unlabeled look-alike icons; standing tabs hidden in More |
| 7 | Flexibility and Efficiency | 3 | Good search shortcuts; no skip link, no arrow keys in rail |
| 8 | Aesthetic and Minimalist Design | 2 | Header row 10-12 targets; same alert shown 4 times on Dashboard; green bolt is the loudest thing |
| 9 | Error Recovery | 3 | Header and rail have fallbacks |
| 10 | Help and Documentation | 3 | Help panel is useful but a third navigation system |
| **Total** | | **25/40** | **Acceptable** |

Priority issues:
- [P1] Module tabs get the leftover width: Tickets at 1440 with the rail open hides All Open in More; at 1024 only Needs Reply shows.
- [P1] First click on the header overflow folds the rail instead of opening the menu.
- [P1] Closed notification drawer (NotificationBell.jsx, Visesh) is in the Tab order and slides the whole shell 560px; no skip link.
- [P2] Back line truncated to "← Da…" / ambiguous labels.
- [P2] Search moves between modules at 1280; profile pill compacts by tabs, not width.
- [P2] Mixed state signals: red Clocked Out on folded rail, cobalt dark-mode pill, last rail rows hidden under the clock with no cue.
- [P3] Duplication: Quick Actions bolt vs Dashboard card, What's New twice, Item vs Asset Management side by side.

Measured: active rail item 4.64:1; search placeholder 4.23:1 light / 3.77:1 dark; rail rows 28px tall; phone menu/search buttons 34/38px; rail is li role=link, unlabeled nav, My Desk group label not announced; phone menu marks no current page.
