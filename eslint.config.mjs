// ABC Desk ESLint 配置：沿用 chatmusic 的工具链习惯（@eslint/js + typescript-eslint），
// 并强制 src/core 与 src/webview 不依赖 vscode API 的分层边界（见 docs/conventions.md）。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'out/**', 'media/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'src/core 必须保持宿主无关，不得依赖 vscode API（见 docs/conventions.md）。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/webview/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'src/webview 不得直接使用 vscode API，经消息桥与扩展侧通信（见 docs/conventions.md）。',
            },
          ],
        },
      ],
    },
  },
);
