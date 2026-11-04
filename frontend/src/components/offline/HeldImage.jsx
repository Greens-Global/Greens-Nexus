// A picture that may still be on the phone (field offline, Neil 11/03/2026).
// An answer holds `nexus-offline:<id>` for a photo taken with no signal until
// the outbox uploads it; this shows it from the phone meanwhile (a blob: URL,
// which the CSP's img-src allows) and an ordinary URL as it is.
import { useEffect, useState } from 'react';
import { blobIdOf, getBlob } from '../../lib/offline/store';

export function useHeldUrl(value) {
  const id = blobIdOf(value);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    let made = '';
    getBlob(id).then((b) => {
      if (!b || !live) return;
      try { made = URL.createObjectURL(b); setUrl(made); } catch { /* no object URLs here */ }
    });
    return () => { live = false; if (made) { try { URL.revokeObjectURL(made); } catch { /* gone */ } } };
  }, [id]);
  return id ? url : value;
}

export default function HeldImage({ src, alt = '', style, ...rest }) {
  const url = useHeldUrl(src);
  if (!url) return <span role="img" aria-label={alt} style={{ display: 'block', background: 'var(--nx-surface2, #f1f5f9)', ...style }} />;
  return <img src={url} alt={alt} style={style} {...rest} />;
}
