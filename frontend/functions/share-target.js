// Cloudflare Pages Function: /share-target with no service worker in front.
//
// Share to Nexus (the manifest's share_target) sends the phone's share sheet
// here as a multipart POST, and public/sw.js answers it on the phone: it
// keeps the words and files in the browser and sends the app to /?share=1.
// This Function only sees the request when the worker did not take it - the
// offline shell's kill switch is on (VITE_OFFLINE_SHELL=off: that worker
// answers nothing), or the worker is not active yet. Pages would answer a
// POST to a static site with a bare 405 page inside the installed app.
//
// So: send the browser home with a 303, exactly where the worker would have.
// The app finds nothing kept and says so. The body is never read, stored or
// forwarded - what was shared never leaves the phone through here.
export function onRequest(context) {
  const home = new URL(context.request.url);
  home.pathname = '/';
  home.search = context.request.method === 'POST' ? '?share=1' : '';
  home.hash = '';
  return new Response(null, { status: 303, headers: { Location: home.href, 'Cache-Control': 'no-store' } });
}
