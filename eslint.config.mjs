import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'cdk.out/**',
      'coverage/**',
      'node_modules/**',
      'mobile/**',
      '**/.agents/**',
      '**/.codex/**',
      '**/.github/hooks/**',
      '**/.github/skills/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
    }
  }
);
