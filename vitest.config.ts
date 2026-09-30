/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

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
      exclude: ['src/lib/constants.ts', 'src/locales/**/*.ts', 'src/types.ts', 'src/**/*.test.ts', 'src/vite-env.d.ts'],
      // Floor di regressione sull’intero runtime. Restano invariati anche dopo
      // il passaggio alla rimappatura AST di Vitest 4: la copertura va protetta
      // tramite contratti osservabili, non diminuendo le soglie.
      thresholds: {
        statements: 92,
        branches: 89,
        functions: 95,
        lines: 92,
      },
    },
  },
});
