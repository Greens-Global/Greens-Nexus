// Items phase 4 - the Scan button for the Items header. Always on a phone
// (with no camera the scanner still offers Type a Serial); on a computer
// only when it has a camera. It opens the scanner the mounted ItemScanHost
// owns - the button itself loads nothing heavy.
import { useEffect, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { useIsMobile } from '../ui/hooks';
import { hasVideoInput } from './camera';
import { openItemScanner } from './events';

export function ItemScanButton({ style, className = 'secondary-btn', label = 'Scan' }) {
  const isMobile = useIsMobile();
  const [hasCamera, setHasCamera] = useState(false);
  useEffect(() => {
    if (isMobile) return undefined;
    let live = true;
    hasVideoInput().then((v) => { if (live) setHasCamera(v); });
    return () => { live = false; };
  }, [isMobile]);
  if (!isMobile && !hasCamera) return null;
  return (
    <button type="button" className={className} onClick={openItemScanner} aria-label="Scan an item tag" title="Scan an item's QR tag"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, ...style }}>
      <ScanLine size={15} /> {label}
    </button>
  );
}
