import js from '@eslint/js';
import globals from 'globals';

// El proyecto son IIFE clásicas que publican en `window.TemaUI` y se abren
// con doble clic (file://), por eso no hay módulos ES ni "use strict" global.
export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.worker,
        TemaUI: 'writable',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
