import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Per GitHub Pages: se il repo si chiama <username>.github.io, lascia '/'; altrimenti usa '/nome-repo/'.
// Override con VITE_BASE_PATH nel .env per deploy personalizzati.
const base = process.env.VITE_BASE_PATH || './';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        // Chunk splitting: separa vendor runtime dalle viste
        manualChunks: {
          'tvmaze-api': ['./src/lib/api.ts'],
        },
      },
    },
  },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: {
        name: 'PloppyTV - Tracker Serie TV',
        short_name: 'PloppyTV',
        description: 'Il tuo tracker personale per serie TV: tracking episodi, calendario, statistiche, scopri nuove serie.',
        start_url: './index.html',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0f0f14',
        theme_color: '#ff6b35',
        lang: 'it',
        dir: 'ltr',
        categories: ['entertainment', 'lifestyle'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // PWA id stabile per evitare che cambiando dominio la PWA venga reinstallata
        id: '/ploppytv/',
        shortcuts: [
          { name: 'Dashboard', url: './index.html#dashboard', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Scopri', url: './index.html#discover', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Calendario', url: './index.html#calendar', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // 5MB hard cap
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
