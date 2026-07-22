#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const REQUIRED_CI_CHECK_NAMES = Object.freeze(['Node 22.18.0', 'Node 24'])

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  }
  return result.stdout.trim()
}

function nextLink(linkHeader) {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/u)
    if (match) return match[1]
  }
  return null
}

async function fetchCheckRuns(repo, sha, token) {
  const perPage = 100
  const runs = []
  let url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=${perPage}`
  let page = 1

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`GitHub check-runs request failed (${response.status}): ${body}`)
    }
    const payload = await response.json()
    const batch = payload.check_runs ?? []
    runs.push(...batch)

    const linkedNext = nextLink(response.headers.get('link'))
    if (linkedNext) {
      url = linkedNext
      page += 1
      continue
    }
    if (batch.length < perPage) break
    page += 1
    url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=${perPage}&page=${page}`
  }

  return runs
}

async function assertCiGreen(repo, sha, token) {
  const required = new Set(REQUIRED_CI_CHECK_NAMES)
  const byName = new Map(
    REQUIRED_CI_CHECK_NAMES.map((name) => [name, { completed: null, pending: false }]),
  )

  for (const checkRun of await fetchCheckRuns(repo, sha, token)) {
    if (!checkRun.app || checkRun.app.slug !== 'github-actions') continue
    if (!required.has(checkRun.name)) continue
    const entry = byName.get(checkRun.name)
    if (checkRun.status === 'completed') {
      if (!entry.completed || checkRun.id > entry.completed.id) {
        entry.completed = checkRun
      }
    } else {
      entry.pending = true
    }
  }

  const failures = []
  for (const name of REQUIRED_CI_CHECK_NAMES) {
    const entry = byName.get(name)
    if (!entry.completed) {
      failures.push(entry.pending ? `${name}: pending` : `${name}: missing`)
      continue
    }
    if (entry.completed.conclusion !== 'success') {
      failures.push(`${name}: ${entry.completed.conclusion ?? 'unknown'}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Required CI checks are not green:\n${failures.join('\n')}`)
  }
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

const repo = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN
if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
await assertCiGreen(repo, sha, token)

console.log(`Validated ${tag} for porteau@${metadata.version}`)
