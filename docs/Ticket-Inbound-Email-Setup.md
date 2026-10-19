# Ticket Inbound Email (Email to Ticket) - Setup

Nexus reads one support mailbox (for example `support@greensglobal.com`) every
minute. A new email from someone on the Nexus People list becomes a ticket; a
reply to a ticket email becomes a comment on that ticket. Everything else is
refused and logged. Code: `backend/ticket_inbound.py`.

## 1. The mailbox

- Use a shared mailbox of its own. It must NOT be the Tasks reply mailbox
  (Tasks > Email Notifications > Reply-to / Mailbox to read). Nexus refuses to
  save that address, and a drain whose mailbox matches it reads nothing.
- Handled mail is marked read and moved to a folder named **Nexus Processed**
  (created on first use). Anything still in the inbox has not been dealt with.
- Nobody gets an automatic reply, so a person watching the mailbox is not
  required, but they will see mail move.

## 2. Microsoft Graph permission

On the Nexus Entra app registration (the one `AZURE_CLIENT_ID` names):

1. API permissions > Add > Microsoft Graph > **Application** permissions >
   `Mail.ReadWrite`. Grant admin consent. (Reading, marking read and moving
   mail all need ReadWrite; `Mail.Send` alone is not enough.)
2. Scope it to the support mailbox with an Exchange **application access
   policy**, so the app cannot read any other mailbox. In Exchange Online
   PowerShell:

   ```powershell
   New-DistributionGroup -Name "Nexus Mail Access" -Type Security -Members support@greensglobal.com
   New-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> `
     -PolicyScopeGroupId "Nexus Mail Access" -AccessRight RestrictAccess `
     -Description "Nexus reads only its own mailboxes"
   Test-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> -Identity support@greensglobal.com
   ```

   If a policy already exists for the Tasks mailbox, add the support mailbox to
   that policy's group instead of creating a second policy.

## 3. Plus addressing

While Email to Ticket is on, every ticket email is sent with a Reply-To of
`support+t<ticket id>.<signature>@greensglobal.com`, so a reply comes back to
its own ticket. Exchange Online must deliver sub-addressed mail:

```powershell
Get-OrganizationConfig | Format-List AllowPlusAddressInRecipients
Set-OrganizationConfig -AllowPlusAddressInRecipients $true   # if it is False
```

Without it, replies bounce. Replies are also matched by their threading
headers and by the "Ticket #N" in the subject, but the address is the reliable
route.

## 4. Switch it on

Admin > Notifications (Ticket Email Notifications), Settings tab:

1. Turn on **Email to Ticket**.
2. **Support Mailbox**: the address from step 1.
3. **Default Department for New Tickets**: one per company. A new email goes to
   the sender's company (from their People record) and that company's
   department. A company with none set has its new emails refused with "no
   default department" - Nexus never guesses one.
   Only a Global Admin can turn Email to Ticket on or off or change the
   mailbox; a company's supervisors set their own company's default
   department.
4. **Save Settings**, then **Check Mailbox Now** (deployed API only) to run one pass immediately.
   An error here is usually the missing `Mail.ReadWrite` grant or access policy.

The deployed API reads the mailbox every minute. A developer laptop never does
(only the deployed worker runs the loop).

## 5. What happens to a message

| Message | Result |
|---|---|
| New email from an active, internal person on the People list | New ticket: they are the requester, priority Medium, type Other, their company's default department, marked "Via Email". The default assignee, approval rules, SLA clock, receipt email and desk notice all apply as in the app. Colleagues on To/CC become collaborators. |
| Reply to a ticket email from someone who may comment on it | Public comment on that ticket (never an internal note), with the same bells and emails as the drawer. Files attach to the ticket. |
| Unknown or outside sender, guest or external account, someone who left | Refused |
| Out-of-office, bounce, mailing list, or mail from one of our own mailboxes | Refused (shown as ignored) |
| Reply All on the original email (before any ticket email went out) | Comment on the ticket that email created - matched by its thread |
| Reply to a ticket the sender cannot see, or one that was deleted | Refused - never a second ticket (a "Ticket #N" in the subject alone is not a reply: if the sender cannot see #N, it is a new email) |
| Exchange says the sender failed authentication (dmarc=fail, compauth=fail, or not sent as Internal) | Refused - each row records what Exchange reported |
| An inbox-rule forward (X-MS-Exchange-Inbox-Rules-Loop and similar) | Refused (shown as ignored) |
| More than 10 new tickets from one sender in an hour | Refused (stops a forwarding loop) |
| A message over 1 MB of text | Refused |

In an emailed reply, a mailto link is kept as an @mention (and adds that
person to the ticket) only when its text starts with "@" and the person can see
the ticket; any other mailto link becomes plain text.

Files go to the private `ticket-evidence` bucket. Shared OneDrive links are not
filed (a ticket's files must be Nexus storage); the log row names them.

## 6. Reading the log

Admin > Notifications > **Inbound Email** tab (ticket supervisors only): the
last 100 messages with their outcome (Ticket Created, Comment Added, Refused,
Failed), sender, subject, received time in your time zone, the reason for any
refusal, and a link to the ticket. "I emailed support and nothing happened" is
answered here - the message itself is already filed away.

## Release notes

- New table `ticket_inbound_email` and column `task_tickets.source` are created
  on startup, with RLS enabled by `main.py`. Run `get_advisors` on dev and prod
  after the release to confirm.
