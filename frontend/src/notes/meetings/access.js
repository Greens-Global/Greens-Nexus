// Meeting Notes: whether this person is one of the testers (GET
// /meetings/access, testers first - Neil, 11/12/2026). The Notes page sets it
// once it knows; the voice note player reads it to offer Transcribe.
let on = false;
export const setTranscribeOn = (v) => { on = !!v; };
export const transcribeOn = () => on;
