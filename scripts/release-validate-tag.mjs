#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  }
  return result.stdout.trim()
}

const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = process.env.GITHUB_REF_NAME
const sha = process.env.GITHUB_SHA

if (!tag || !sha) throw new Error('GITHUB_REF_NAME and GITHUB_SHA are required')
if (!/^v\d+\.\d+\.\d+-alpha\.\d+$/u.test(tag))
  throw new Error(`Tag ${tag} is not an alpha release tag`)
if (tag !== `v${metadata.version}`)
  throw new Error(`Tag ${tag} does not match package.json version ${metadata.version}`)
if (run('git', ['rev-list', '-n', '1', tag]) !== sha)
  throw new Error(`Tag ${tag} does not point at ${sha}`)
run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'])

if (metadata.name !== 'porteau') throw new Error('Unexpected package name')
if (metadata.license !== 'Apache-2.0') throw new Error('Unexpected package license')
if (metadata.repository?.url !== 'git+https://github.com/sebastiaanwouters/porteau.git')
  throw new Error('Unexpected package repository')
if (metadata.publishConfig?.tag !== 'next')
  throw new Error('Alpha releases must publish under the next dist-tag')

console.log(`Validated ${tag} for porteau@${metadata.version}`)
