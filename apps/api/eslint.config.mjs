// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.mjs', 'test/*.config.js'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* Constitution §39: `any` is not an escape hatch. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      /* Constitution §28: observability must not depend on console.log. */
      'no-console': 'error',

      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'no-public' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      /* Nest decorators legitimately produce "unnecessary" parameter properties. */
      '@typescript-eslint/parameter-properties': 'off',

      /* `process.env` is an index signature; bracket access is the correct form and
         stays correct if `noPropertyAccessFromIndexSignature` is enabled later. */
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
    },
  },
  {
    /* A Nest module is a decorated, deliberately empty class: the decorator is the
       whole point, so `no-extraneous-class` cannot apply here. */
    files: ['**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  {
    /* Entrypoints that run before (or outside) the structured logger. */
    files: [
      'src/main.ts',
      'src/openapi-export.ts',
      'src/infrastructure/database/migrate.ts',
      'src/infrastructure/observability/**/*.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  prettierConfig,
);
