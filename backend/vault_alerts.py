"""Credential alerts by email and bell (Pranshu, 11/13/2026) - to the owner,
the backup owner and the head (and backup head) of the login's department.

Expiry: a login expires on its Expires On date or when its rotation falls due,
whichever is first. An email and a bell go out 3 days before, 1 day before and
on the day, then once a week while it stays expired. Changing the password
moves the rotation on, so the alerts stop by themselves.

Needs attention: a password that is weak, found in a breach, reused or shared
with someone outside Nexus (vault_external) alerts
once when it starts and weekly after, until it is changed.

Each alert is one NexusNotification row per person (type vault_expiry /
vault_expired / vault_attention, ref_id = the credential); "already sent" is
read from those rows, so a missed day never sends twice and nothing new is
stored. Runs daily from reminders_loop (routers/credvault.rotation_reminders,
Workflows > Automations switch credvault_rotation) and once right after a
login is saved, so an already-expired login tells its people straight away.
"""
from datetime import datetime, timedelta, timezone

import models

WARN_DAYS = (3, 1, 0)       # days before the expiry that send an alert
REPEAT_DAYS = 7             # expired / needs attention: again every week


def days_left(c, days_since, days_until):
    """Days until the login expires (negative = expired), or None."""
    left = []
    if c.rotated_at:
        left.append((c.rotation_max or 90) - days_since(c.rotated_at))
    hard = days_until(c.expires_at)
    if hard is not None:
        left.append(hard)
    return min(left) if left else None


def attention(c, reused: bool, exposed: bool = False) -> list:
    out = []
    if c.breached:
        out.append("its password was found in a known data breach")
    if (c.strength or "") == "weak":
        out.append("its password is weak")
    if reused:
        out.append("its password is used on another login too")
    if exposed:
        out.append("its password was shared with someone outside Nexus")
    return out


def _sent_since(db, ntype: str, cred_id: str, since: datetime) -> bool:
    return (db.query(models.NexusNotification.id)
            .filter(models.NexusNotification.type == ntype, models.NexusNotification.ref_id == cred_id,
                    models.NexusNotification.created_at >= since.strftime("%Y-%m-%d")).first()) is not None


def due(db, c, *, reused: bool, days_since, days_until, today: datetime, exposed: bool = False) -> list:
    """[(type, title, line)] - what this login should say today."""
    out = []
    left = days_left(c, days_since, days_until)
    if left is not None and left in WARN_DAYS and not _sent_since(db, "vault_expiry", c.id, today):
        out.append(("vault_expiry", "Credentials - Expires Soon" if left else "Credentials - Expires Today",
                    "it expires today" if left == 0 else f"it expires in {left} day{'s' if left != 1 else ''}"))
    if left is not None and left < 0 and not _sent_since(db, "vault_expired", c.id, today - timedelta(days=REPEAT_DAYS - 1)):
        out.append(("vault_expired", "Credentials - Expired",
                    f"it expired {-left} day{'s' if left != -1 else ''} ago"))
    issues = attention(c, reused, exposed)
    if issues and not _sent_since(db, "vault_attention", c.id, today - timedelta(days=REPEAT_DAYS - 1)):
        out.append(("vault_attention", "Credentials - Needs Attention", " and ".join(issues)))
    return out


def run(db, creds, *, reused_of, heads_of, days_since, days_until, notify, mail, only=None, exposed_of=lambda c: False) -> int:
    """Send what is due for `creds` (or just `only`). `notify(type, who, title,
    body, cred)` adds a bell; `mail(to_list, subject, body, cred)` emails.
    Returns how many alerts went out. The caller commits."""
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    sent = 0
    for c in creds:
        if only is not None and c.id != only:
            continue
        if c.deleted_at:
            continue
        items = due(db, c, reused=reused_of(c), days_since=days_since, days_until=days_until, today=today, exposed=exposed_of(c))
        if not items:
            continue
        people = []
        for e in [c.owner_email, c.backup_owner_email, *sorted(heads_of(c))]:
            e = (e or "").strip().lower()
            if e and e not in people:
                people.append(e)
        for ntype, title, line in items:
            body = f"{c.name} ({c.dept or 'every department'}): {line}. Change the password and save it in Credentials."
            for who in people:
                notify(ntype, who, title, body, c)
            mail(people, title, body, c)
            sent += 1
    return sent
