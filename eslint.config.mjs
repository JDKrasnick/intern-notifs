import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'browser-companion/dist/**',
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
    files: ['browser-companion/**/*.{ts,js}'],
    languageOptions: {
      globals: {
        CSS: 'readonly',
        Event: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        MutationObserver: 'readonly',
        URL: 'readonly',
        chrome: 'readonly',
        document: 'readonly',
        location: 'readonly',
        sessionStorage: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
    }
  }
);
