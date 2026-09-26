import { defineConfig } from 'tsup'

export default defineConfig({
  // Named entries: output is flattened under dist/ (dist/main.js, dist/worker.js, dist/migrate.js, dist/setup-once.js, dist/demo-reset.js),
  // regardless of which directory the source file lives in (src/ or scripts/).
  entry: {
    main: 'src/main.ts',
    worker: 'src/worker.ts',
    'rotate-gateway-key': 'scripts/rotate-gateway-key.ts',
    'legacy-archive': 'scripts/legacy-archive.ts',
    'legacy-import': 'scripts/legacy-import.ts',
    migrate: 'src/db/migrate-cli.ts',
    'setup-once': 'scripts/setup-once.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Dependencies stay external and are provided by node_modules; only the @/ alias is bundled into the output
  skipNodeModulesBundle: true,
})
