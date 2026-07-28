// Strips the "Z #Inactive " prefix Azure AD adds to disabled accounts.
// Safe to call on any string - returns it unchanged if the prefix isn't present.
export function cleanName(name) {
  if (!name) return name;
  return name.replace(/^Z\s*#Inactive\s*/i, '').trim();
}

// Turns a work email into a "First Last" display name
// (visesh.lodha@greensglobal.com → "Visesh Lodha"). A value that's already a name
// is returned unchanged. Use anywhere a person is shown to users - people must
// never be addressed by a raw email address.
export function emailToName(value) {
  const v = cleanName((value || '').trim());
  if (!v) return '-';
  if (!v.includes('@')) return v;
  return v.split('@')[0].split(/[._-]+/).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') || v;
}
