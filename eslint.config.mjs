import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['out/**', 'node_modules/**', 'media/**', 'coverage/**', '**/*.js', '**/*.mjs', '.vscode-test/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      'no-console': ['error', { allow: ['warn'] }],
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'off',
      'no-new-func': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
);
