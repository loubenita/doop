import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncUpstream, type SyncOptions } from '../scripts/upstreamSync.ts'

const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let dir: string
let work: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim()
}

function commit(cwd: string, file: string, text: string): void {
  writeFileSync(path.join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', `edit ${file}`)
}

/** An upstream repo, a fork of it and a checkout of the fork, each with one shared commit on main. */
function setUp(): void {
  dir = mkdtempSync(path.join(tmpdir(), 'doop-upstream-sync-'))
  const seed = path.join(dir, 'seed')
  git(dir, 'init', '-q', '-b', 'main', seed)
  commit(seed, 'shared.txt', 'one\n')
  git(dir, 'clone', '-q', '--bare', seed, 'upstream.git')
  git(dir, 'clone', '-q', '--bare', seed, 'fork.git')
  work = path.join(dir, 'work')
  git(dir, 'clone', '-q', path.join(dir, 'fork.git'), work)
  const gh = path.join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${path.join(dir, 'gh.log')}"\necho https://github.com/loubenita/doop/pull/7\n`,
  )
  chmodSync(gh, 0o755)
  /* What gh says when the repository does not let GitHub Actions open pull requests. */
  const refusingGh = path.join(dir, 'gh-refuses')
  writeFileSync(
    refusingGh,
    `#!/bin/sh\necho 'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)' >&2\nexit 1\n`,
  )
  chmodSync(refusingGh, 0o755)
}

/** Lands a commit on a bare repo's main through a throwaway clone. */
function land(bare: string, file: string, text: string): void {
  const clone = path.join(dir, `clone-${Math.random().toString(36).slice(2)}`)
  git(dir, 'clone', '-q', path.join(dir, bare), clone)
  commit(clone, file, text)
  git(clone, 'push', '-q', 'origin', 'main')
}

function options(overrides: Partial<SyncOptions> = {}): SyncOptions {
  return {
    repoDir: work,
    upstreamUrl: path.join(dir, 'upstream.git'),
    forkRepo: 'loubenita/doop',
    baseBranch: 'main',
    date: '2026-11-16',
    testCommand: 'echo all tests passed',
    gh: path.join(dir, 'gh'),
    summaryFile: path.join(dir, 'summary.md'),
    env: identity,
    ...overrides,
  }
}

function ghLog(): string {
  const log = path.join(dir, 'gh.log')
  return existsSync(log) ? readFileSync(log, 'utf8') : ''
}

function summary(): string {
  const file = path.join(dir, 'summary.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function forkHas(ref: string): boolean {
  try {
    git(path.join(dir, 'fork.git'), 'rev-parse', '--verify', '-q', ref)
    return true
  } catch {
    return false
  }
}

describe('daily merge of upstream into the fork', () => {
  beforeEach(setUp)
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('pushes a dated branch holding upstream and the fork, and reports it in a pull request and the run summary', () => {
    land('upstream.git', 'upstream.txt', 'from upstream\n')
    land('fork.git', 'fork.txt', 'ours\n')

    const result = syncUpstream(
      // printf, so the expected output is not also the command text the report quotes
      options({ testCommand: "test -f upstream.txt && test -f fork.txt && printf '%s passed\\n' 2914" }),
    )

    expect(result.outcome).toBe('ready')
    expect(result.pullRequestUrl).toBe('https://github.com/loubenita/doop/pull/7')
    const branch = 'upstream-sync/2026-11-16'
    expect(forkHas(branch)).toBe(true)
    const upstreamHead = git(path.join(dir, 'upstream.git'), 'rev-parse', 'main')
    const forkHead = git(path.join(dir, 'fork.git'), 'rev-parse', 'main')
    git(path.join(dir, 'fork.git'), 'merge-base', '--is-ancestor', upstreamHead, branch)
    git(path.join(dir, 'fork.git'), 'merge-base', '--is-ancestor', forkHead, branch)
    expect(forkHead).toBe(git(path.join(dir, 'fork.git'), 'rev-parse', 'main'))
    const log = ghLog()
    expect(log).toContain('pr\ncreate\n--repo\nloubenita/doop\n--base\nmain\n--head\nupstream-sync/2026-11-16')
    expect(log).not.toContain('--draft')
    expect(log).not.toContain('issue')
    for (const report of [log, summary()]) {
      expect(report).toContain('https://github.com/loubenita/doop/compare/main...upstream-sync/2026-11-16')
      expect(report).toContain('edit upstream.txt')
      expect(report).toContain('2914 passed')
    }
    expect(summary()).toContain('https://github.com/loubenita/doop/pull/7')
  })

  it('still reports in the run summary, with a link to open the pull request, when GitHub refuses to open it', () => {
    land('upstream.git', 'upstream.txt', 'from upstream\n')

    const result = syncUpstream(options({ gh: path.join(dir, 'gh-refuses') }))

    expect(result.outcome).toBe('ready')
    expect(result.pullRequestUrl).toBeUndefined()
    expect(forkHas('upstream-sync/2026-11-16')).toBe(true)
    expect(summary()).toContain('GitHub Actions is not permitted to create or approve pull requests')
    expect(summary()).toContain('https://github.com/loubenita/doop/compare/main...upstream-sync/2026-11-16?expand=1')
    expect(summary()).toContain('edit upstream.txt')
  })

  it('reports nothing new and touches nothing when upstream has no commits the fork lacks', () => {
    land('fork.git', 'fork.txt', 'ours\n')

    const result = syncUpstream(options())

    expect(result.outcome).toBe('up-to-date')
    expect(forkHas('upstream-sync/2026-11-16')).toBe(false)
    expect(ghLog()).toBe('')
    expect(summary()).toContain('already in origin/main')
  })

  it('stops on a merge conflict, names the conflicted files in the run summary and pushes nothing', () => {
    land('upstream.git', 'shared.txt', 'upstream wording\n')
    land('fork.git', 'shared.txt', 'our wording\n')

    const result = syncUpstream(options({ testCommand: 'echo tests ran; exit 1' }))

    expect(result.outcome).toBe('conflict')
    expect(forkHas('upstream-sync/2026-11-16')).toBe(false)
    expect(git(work, 'status', '--porcelain')).toBe('')
    expect(ghLog()).toBe('')
    const report = summary()
    expect(report).toContain('conflict')
    expect(report).toContain('shared.txt')
    expect(report).not.toContain('tests ran')
  })

  it('stops on failing tests, pushes the branch for inspection and puts the failure in a draft pull request', () => {
    land('upstream.git', 'upstream.txt', 'from upstream\n')

    const result = syncUpstream(options({ testCommand: "printf 'FAIL %s\\n' tests/fonts.test.ts; exit 1" }))

    expect(result.outcome).toBe('tests-failed')
    expect(forkHas('upstream-sync/2026-11-16')).toBe(true)
    const log = ghLog()
    expect(log).toContain('--draft')
    for (const report of [log, summary()]) {
      expect(report).toContain('tests failed')
      expect(report).toContain('FAIL tests/fonts.test.ts')
    }
  })
})
