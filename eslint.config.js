import globals from 'globals';

export default [
  {
    files: ['server/**/*.js', 'server/**/*.mjs', 'scripts/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
  // Frontend: catches missing-import render errors (undefined component/variable
  // references in JSX) before they hit the browser as a ReferenceError from
  // renderWithHooks. Added 2026-07-13 after a code-split refactor left a used-but-
  // unimported component (LivePlaybookCard in ACDView.jsx) that only surfaced via
  // the error watcher, not a build step — no-undef with jsx:true parsing catches
  // this class of bug statically instead.
  {
    files: ['src/**/*.jsx', 'src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
