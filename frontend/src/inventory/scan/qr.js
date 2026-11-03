// Items phase 4 - QR codes for the printed tags, made in the browser.
//
// The self-hosted `qrcode` package (vendor-qr, loaded only when a tag sheet
// opens) builds the module matrix; we draw it ourselves as one SVG path, so
// the print is vector-sharp at any label size and no image or network call
// is involved.

import { itemUrl } from './itemLink';

const loadQrDefault = () => import('qrcode').then((m) => m.default || m);

/** The text a tag's QR code carries: the item's own link on this app's origin. */
export function qrPayload(id, origin) {
  return itemUrl(id, origin);
}

/** An SVG path ("M x y h n v1 h-n z ...") drawing every dark module, one unit each. */
export function matrixPath(size, isDark) {
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!isDark(y, x)) { x++; continue; }
      let run = 1;
      while (x + run < size && isDark(y, x + run)) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return d;
}

/**
 * A QR code factory: make(text) -> { size, path }. Loads the library once.
 * Error correction M survives a scuffed or slightly curled tag.
 */
export async function createQrMaker({ load = loadQrDefault, ecc = 'M' } = {}) {
  const QR = await load();
  return (text) => {
    const qr = QR.create(String(text || ''), { errorCorrectionLevel: ecc });
    const { size } = qr.modules;
    return { size, path: matrixPath(size, (r, c) => !!qr.modules.get(r, c)) };
  };
}
