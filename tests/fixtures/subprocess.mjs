#!/usr/bin/env node

const exitCode = Number.parseInt(process.argv[2] ?? '0', 10)

process.stdout.write('fixture stdout\n')
process.stderr.write('fixture stderr\n')
process.exitCode = exitCode
