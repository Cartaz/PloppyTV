/** @type {import('lint-staged').Configuration} */
module.exports = {
  // Esegui ESLint solo sui file di source code, non sui config di tooling
  'src/**/*.{ts,tsx,js,cjs,mjs}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  'tests/**/*.{ts,tsx,js,cjs,mjs}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{json,css,html}': ['prettier --write'],
  // Markdown: scritto a mano, non passare Prettier (vedi .prettierignore)
};
