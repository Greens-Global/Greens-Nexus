// The client draft on Edit Job (Round Three item 2, 11/11/2026): the job's
// Intacct customer and who signs, saved by its own call under Edit Job's one
// Save (routers/construction_subs.py PUT /projects/{id}/client). The rows
// are ClientRows.jsx.
import { useMemo } from 'react';
import { api } from '../../api';
import { useDraft } from '../../lib/useDraft';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const savedOf = (p) => ({
  clientId: p.clientId || '', clientName: p.clientName || '',
  contactName: p.clientContactName || '', contactEmail: p.clientContactEmail || '',
});

export function useClientDraft(project) {
  const saved = useMemo(() => savedOf(project), [project]);
  const { draft, patch, dirty, reset } = useDraft(saved);
  const email = draft.contactEmail.trim();
  const invalid = email && !EMAIL.test(email) ? 'The client contact email is not an email address.' : '';
  const save = () => api.setJobClient(project.id, {
    client_id: draft.clientId, contact_name: draft.contactName.trim(), contact_email: email.toLowerCase(),
  });
  return { draft, patch, dirty, reset, invalid, save, projectId: project.id };
}

