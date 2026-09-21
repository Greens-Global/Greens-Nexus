import { busDay, busDayIdx, mEnd, toISO } from "./months";
export const TARGET_CLOSE_DAY = 10;
export function closeState(tasks, completions, period, today = new Date()) {
    const periodEnd = mEnd(period);
    const todayISO = toISO(today);
    const doneBy = new Map(completions.map((c) => [c.task_id, c]));
    const rows = tasks
        .filter((t) => t.is_active)
        .sort((a, b) => a.sort - b.sort || a.day_offset - b.day_offset)
        .map((t) => {
        const due = busDay(periodEnd, t.day_offset);
        const done = doneBy.get(t.id) ?? null;
        const state = done ? "done" : due < todayISO ? "past_due" : due === todayISO ? "due_today" : "open";
        return { ...t, due, done, state };
    });
    const phases = [];
    for (const r of rows) {
        let p = phases.find((x) => x.phase === r.phase);
        if (!p) {
            p = { phase: r.phase, rows: [], done: 0 };
            phases.push(p);
        }
        p.rows.push(r);
        if (r.done)
            p.done++;
    }
    const n = rows.length;
    const nDone = rows.filter((r) => r.done).length;
    const late = rows.filter((r) => r.state === "past_due");
    const expected = rows.filter((r) => r.due <= todayISO).length;
    const dayN = busDayIdx(periodEnd, todayISO);
    const planned = Array.from({ length: 13 }, (_, d) => rows.filter((r) => r.day_offset <= d).length);
    const actual = Array.from({ length: Math.max(0, Math.min(12, dayN)) }, (_, i) => {
        const d = i + 1;
        return rows.filter((r) => r.done && busDayIdx(periodEnd, r.done.completed_at.slice(0, 10)) <= d).length;
    });
    const status = n === 0 ? "Not started" : nDone === n ? "Closed" : late.length ? "Behind" : "On track";
    return { period, periodEnd, rows, phases, n, nDone, late, expected, dayN, targetDate: busDay(periodEnd, TARGET_CLOSE_DAY), status, planned, actual };
}
