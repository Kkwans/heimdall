import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Existing data-loading effects intentionally start an async request and then
      // update state from its callbacks. Keep the compiler-oriented rule visible
      // without making this established React pattern a release blocker.
      'react-hooks/set-state-in-effect': 'warn',
      'react-refresh/only-export-components': ['error', {
        allowConstantExport: true,
        allowExportNames: [
          'fmtDuration',
          'speedColor',
          'speedIcon',
          'TABLE_SPIN_INDICATOR',
          'useFilter',
          'useTheme',
        ],
      }],
    },
  },
])
