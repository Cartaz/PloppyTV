/// <reference types="vitest" />
import { defineConfig } from 'vite';

// `virtual:pwa-register` esiste durante la build tramite vite-plugin-pwa ma non
// nel transform dev di Vitest. Un solo shim qui rende testabile main.ts nella
// stessa suite di tutto il resto, evitando una seconda configurazione speciale.
const virtualPwaRegisterPlugin = {
  name: 'provide-virtual-pwa-register',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (id === 'virtual:pwa-register') return '\0virtual:pwa-register';
    return null;
  },
  load(id: string) {
    if (id !== '\0virtual:pwa-register') return null;
    return `
      export function registerSW(opts) {
        const hook = globalThis.__mainProbeRegisterSWHook;
        if (hook) return hook(opts);
        return () => Promise.resolve();
      }
    `;
  },
};

export default defineConfig({
  plugins: [virtualPwaRegisterPlugin],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Misura tutto il codice runtime. I file esclusi sono solo dichiarazioni
      // di tipo o tabelle/dati senza comportamento da esercitare.
      include: ['src/**/*.ts'],
      exclude: [
        'src/lib/constants.ts',
        'src/locales/**/*.ts',
        'src/types.ts',
        'src/**/*.test.ts',
        'src/vite-env.d.ts',
      ],
      // Baseline temporaneo del branch: viene rialzato dopo la prima misura
      // completa prima di portare il cambiamento su main.
      thresholds: {
        statements: 30,
        branches: 30,
        functions: 30,
        lines: 30,
      },
    },
  },
});
