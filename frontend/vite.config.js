import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cache namespace (Jul 28, "nx2"): rotates EVERY asset URL past the poisoned
// cache entries from tonight's deploy races. Vendor chunk hashes are stable
// across deploys (their content never changes), so a browser/edge that cached
// the SPA-fallback HTML under vendor-react-<hash>.js was bricked FOREVER -
// no redeploy ever changed that URL (Neil: "spins until I open incognito").
// Bumping the filename prefix gives every asset a never-before-seen URL in
// one shot, no user action needed. The /assets/* Pages Function guarantees
// nothing poisonous is cacheable from here on, so this should never need a
// bump again - but if it ever does, increment nx2 -> nx3.
const CACHE_NS = 'nx2';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${CACHE_NS}-[hash].js`,
        chunkFileNames: `assets/[name]-${CACHE_NS}-[hash].js`,
        assetFileNames: `assets/[name]-${CACHE_NS}-[hash][extname]`,
        // Split vendors into separate cached chunks — same approach as Amazon, Netflix, etc.
        // Each chunk loads in parallel and is cached independently by the browser.
        manualChunks(id) {
          if (id.includes('@azure/msal-browser') || id.includes('@azure/msal-react')) return 'vendor-msal';
          if (id.includes('@supabase/supabase-js'))  return 'vendor-supabase';
          if (id.includes('lucide-react'))            return 'vendor-icons';
          // Heavy libs get their OWN chunks so they load on demand instead of on
          // first paint. They're only reached from lazy views / dynamic import()s,
          // so once they're out of the vendor catch-all below they stop shipping
          // on boot. (Previously the catch-all forced ALL node_modules into one
          // 2.7MB chunk, defeating the lazy-loading the source already does.)
          if (id.includes('recharts') || id.includes('/d3-') || id.includes('victory-vendor')) return 'vendor-charts';
          if (id.includes('xlsx'))                    return 'vendor-xlsx';
          if (id.includes('pdf-lib') || id.includes('pdfjs-dist')) return 'vendor-pdf';
          if (id.includes('mammoth'))                 return 'vendor-docx';
          if (id.includes('leaflet'))                 return 'vendor-maps';
          if (id.includes('qrcode'))                  return 'vendor-qr';
          if (id.includes('node_modules'))            return 'vendor-react';
        },
      },
    },
  },
})
