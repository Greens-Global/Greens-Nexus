// Strips the "Z #Inactive " prefix Azure AD adds to disabled accounts.
// Safe to call on any string — returns it unchanged if the prefix isn't present.
export function cleanName(name) {
  if (!name) return name;
  return name.replace(/^Z\s*#Inactive\s*/i, '').trim();
}
