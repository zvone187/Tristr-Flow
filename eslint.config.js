'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'implementation assets/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Existing renderer/provider code intentionally keeps a few state values,
      // compatibility arguments, and empty catches. Keep the new pre-commit
      // gate focused on correctness rules without forcing an unrelated cleanup.
      'no-empty': 'off',
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
    },
  },
];
