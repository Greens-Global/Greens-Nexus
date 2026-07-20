import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    rollupOptions: {
      output: {
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
