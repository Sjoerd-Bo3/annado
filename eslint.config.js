import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'src-tauri', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Compiler-derived diagnostics: real cleanup backlog, tracked but not blocking.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The platform seam: the UI must reach Tauri only through src/backend/.
    // Keep `@tauri-apps/*` imports out of the rest of the app so the same UI
    // can run under a different host (Obsidian plugin, web) by swapping the
    // backend implementation.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/backend/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/*'],
              message: 'Import platform access from "../backend" instead of @tauri-apps/* directly (keeps the UI host-agnostic).',
            },
          ],
        },
      ],
    },
  }
);
