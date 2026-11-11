export const CRED_STATE = {
  valid: { label: 'Valid', color: 'hsl(var(--color-green))' },
  expiring: { label: 'Expiring Soon', color: 'hsl(var(--color-gold))', warn: true },
  expired: { label: 'Expired', color: 'hsl(var(--color-red))', warn: true },
  no_expiry: { label: 'No Expiry', color: '#64748b' },
};
