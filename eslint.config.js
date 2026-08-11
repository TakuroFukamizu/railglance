import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.claude/**', 'infra/**/.terraform/**'],
  },
  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'infra/cloudflare/telemetry-worker/src/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // The Even Hub SDK and test doubles still expose untyped native values.
      // Keep those boundaries explicit while enforcing the remaining recommended rules.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
