/* eslint-env node */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    worker: true,
    node: true,
  },
  // Globali esposti dal browser / service worker / PWA plugin.
  // Dichiarati esplicitamente perché gli ambienti ESLint `browser`/`worker` non
  // coprono sempre tutte le API usate da una PWA (FileReaderSync, defineOptions, ...).
  globals: {
    requestAnimationFrame: 'readonly',
    cancelAnimationFrame: 'readonly',
    localStorage: 'readonly',
    window: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    fetch: 'readonly',
    CustomEvent: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    Date: 'readonly',
    console: 'readonly',
    isNaN: 'readonly',
    Number: 'readonly',
    JSON: 'readonly',
    Object: 'readonly',
    Array: 'readonly',
    Math: 'readonly',
    URL: 'readonly',
    Blob: 'readonly',
    FileReader: 'readonly',
    HTMLInputElement: 'readonly',
    HTMLElement: 'readonly',
    HTMLSelectElement: 'readonly',
    HTMLTextAreaElement: 'readonly',
    Event: 'readonly',
    KeyboardEvent: 'readonly',
    MessageEvent: 'readonly',
    ErrorEvent: 'readonly',
    Worker: 'readonly',
    FileReaderSync: 'readonly',
    defineOptions: 'readonly',
    self: 'readonly',
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'dev-dist/',
    'coverage/',
    '*.config.ts',
    '*.config.js',
    'src/vite-env.d.ts',
    'scripts/test-entry.ts',
  ],
  rules: {
    // Prettier si occupa della formattazione; ESLint si concentra su bug reali
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/consistent-type-imports': [
      'warn',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['warn', 'smart'],
    'prefer-const': 'warn',
    'no-var': 'warn',
  },
  overrides: [
    // I file di test possono usare qualsiasi globals di Vitest
    {
      files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**'],
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    // Il service worker ha il proprio scope di globals
    {
      files: ['src/sw.ts', 'src/worker/**/*.ts'],
      rules: {
        'no-restricted-globals': 'off',
      },
    },
  ],
};
