import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
  fmt: {
    semi: false,
    singleQuote: true,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: ['dist/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    entry: 'src/cli.ts',
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
})
