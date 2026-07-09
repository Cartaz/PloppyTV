// Vitest config dedicated to probe_main.test.ts.
// Adds a Vite plugin that provides the 'virtual:pwa-register' module
// (which is normally provided by vite-plugin-pwa in build/preview, but is
// not available in vitest's dev-mode transform pipeline).
//
// Usage: npx vitest run --config vitest.config.main.ts tests/probe_main.test.ts
//
// This file is additive — it does not modify the existing vitest.config.ts.
// We set a process env marker so the test file can self-skip when run under
// the default config (where 'virtual:pwa-register' isn't resolvable, which
// would cause every dynamic import of main.ts to fail).

import { defineConfig } from 'vite';

process.env.VITEST_MAIN_CONFIG = '1';

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
        const hook = (globalThis).__mainProbeRegisterSWHook;
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
    include: ['tests/probe_main.test.ts'],
  },
});
