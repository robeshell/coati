import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'drizzle/**', 'data/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      // Timestamp output must go through common/serialize.toIso / utcNowIso (ISO 8601 in UTC with 6-digit microseconds; toISOString keeps milliseconds only)
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toISOString']",
          message: '禁止 Date#toISOString()：时间输出用 common/serialize 的 toIso() / utcNowIso()',
        },
      ],
      // Allow let in a destructuring as long as one of the variables is reassigned (date/time parsing code uses this pattern heavily)
      'prefer-const': ['error', { destructuring: 'all' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // Existing protocol fixtures intentionally construct malformed and provider-specific JSON.
    // Their dynamic payloads are checked by the gateway contract matrix, not production DTOs.
    files: ['test/gateway*.test.ts', 'test/parallel-tool-fixture.ts', 'test/reasoning-fixture.ts', 'scripts/live-acceptance.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Fixtures exercise historical millisecond timestamps and parser boundaries as well as the new API format.
    files: ['test/gateway.test.ts', 'test/gateway-selection.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['src/modules/gateway/routes.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['*repository*', '@/db/*', 'drizzle-orm'], message: '网关 HTTP 入口通过服务层访问存储，不直接导入 repository 或数据库。' }],
      }],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.property.name='toISOString']", message: '时间输出使用 common/serialize。' },
        { selector: "MemberExpression[property.name='repo']", message: '网关 HTTP 入口不能绕过服务层访问 repo。' },
        { selector: "VariableDeclarator[id.type='ObjectPattern'] > ObjectPattern > Property[key.name='repo']", message: '网关 HTTP 入口不能解构 repository。' },
      ],
    },
  },
)
