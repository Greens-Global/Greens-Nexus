// What PDF Tools says when Egnyte says no. Never the server's own words: a person
// reading "API error 500" over their document has learned nothing.
const NOT_SET_UP = 'Egnyte is not connected to Nexus yet. An administrator needs to add the Egnyte domain and API token.';
const NOT_LINKED = 'Connect your Egnyte account first, from the Egnyte module, so you see the folders you have access to.';
const NO_TOKEN = 'Egnyte rejected the connection. An administrator needs to refresh the stored API token.';
const NOT_ALLOWED = 'Your account does not have access to Egnyte. Ask an administrator if you need it.';
const NOT_FOUND = 'That folder or file is no longer in Egnyte.';

function known(err) {
  switch (err?.status) {
    case 503: return NOT_SET_UP;
    case 428: return NOT_LINKED;
    case 401: return NO_TOKEN;
    case 404: return NOT_FOUND;
    default: return '';
  }
}

export const browseProblem = (err) => known(err) || (err?.status === 403 ? NOT_ALLOWED : 'Could not reach Egnyte just now. Try again in a moment.');

export const openProblem = (target, err) => {
  if (target?.kind !== 'egnyte') return 'Could not get that document as a PDF. Try again in a moment.';
  if (err?.status === 403) return 'You do not have access to that file in Egnyte.';
  return known(err) || 'Could not open that file from Egnyte. Try again in a moment.';
};

export function saveProblem(err) {
  if (err?.status === 403) return 'You do not have permission to save in that folder. Saving to Egnyte needs supervisor access and access to the folder.';
  if (err?.status === 413 || err?.tooLarge) return 'This PDF is too large to save through Nexus (the limit is 100 MB). Download it and upload it in Egnyte directly.';
  if (err?.status === 404) return 'That folder is no longer in Egnyte. Choose another one.';
  return known(err) || 'Could not save to Egnyte. Your document is still open here. Try again in a moment.';
}

export const statusProblem = (status) => {
  if (!status) return 'Could not reach Egnyte just now. Try again in a moment.';
  if (!status.configured) return NOT_SET_UP;
  return '';
};
