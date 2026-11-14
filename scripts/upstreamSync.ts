/**
 * Weekly merge of upstream Doop (kgoedecke/doop) into this fork.
 *
 * Merges upstream main into a dated `upstream-sync/<date>` branch cut from the fork's main, runs the
 * tests on the merged tree, pushes the branch and opens an issue on the fork with the compare link
 * and the test result, so a person opens the pull request. A merge conflict stops before anything
 * is pushed, and the issue names the conflicted files; failing tests still push the branch, so the
 * compare link shows what broke. Nothing is merged into main and nothing is deployed.
 *
 * Run by .github/workflows/upstream-sync.yml every Monday, inside a checkout of the fork:
 *   bun x tsx scripts/upstreamSync.ts --upstream <url> --repo <owner/name> [--base main] [--test "<cmd>"]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export interface SyncOptions {
  repoDir: string
  upstreamUrl: string
  forkRepo: string
  baseBranch: string
  /** YYYY-MM-DD, names the branch */
  date: string
  testCommand: string
  /** the gh binary; tests pass a stand-in */
  gh?: string
  /** extra environment for git and the test command */
  env?: Record<string, string>
}

export type SyncOutcome = 'up-to-date' | 'ready' | 'conflict' | 'tests-failed'

export interface SyncResult {
  outcome: SyncOutcome
  report: string
  branch?: string
  issueUrl?: string
}

const TEST_OUTPUT_TAIL = 60

export function syncUpstream(opts: SyncOptions): SyncResult {
  const env = { ...process.env, ...opts.env }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: opts.repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const base = `origin/${opts.baseBranch}`

  git('fetch', '-q', 'origin', opts.baseBranch)
  git('fetch', '-q', opts.upstreamUrl, 'main')
  const upstreamHead = git('rev-parse', 'FETCH_HEAD')
  const upstreamCommits = git('log', '--oneline', '--no-decorate', `${base}..${upstreamHead}`)
  if (!upstreamCommits) {
    return { outcome: 'up-to-date', report: `Upstream main ${upstreamHead.slice(0, 7)} is already in ${base}.` }
  }

  const branch = `upstream-sync/${opts.date}`
  const commitCount = upstreamCommits.split('\n').length
  const commits = `Upstream commits (${commitCount}):\n\n${fenced(upstreamCommits)}`
  git('checkout', '-q', '-B', branch, base)
  const merge = spawnSync(
    'git',
    ['merge', '--no-ff', '--no-edit', '-m', `chore: merge upstream main ${upstreamHead.slice(0, 7)}`, upstreamHead],
    { cwd: opts.repoDir, env, encoding: 'utf8' },
  )
  if (merge.status !== 0) {
    const conflicted = git('diff', '--name-only', '--diff-filter=U')
    git('merge', '--abort')
    const report = [
      `Upstream merge stopped: merge conflict in ${conflicted.split('\n').length} file(s). Nothing was pushed.`,
      `Conflicted files:\n\n${fenced(conflicted)}`,
      commits,
    ].join('\n\n')
    return openIssue(opts, env, { outcome: 'conflict', report }, `Upstream merge ${opts.date}: conflict`)
  }

  const tests = spawnSync('sh', ['-c', opts.testCommand], { cwd: opts.repoDir, env, encoding: 'utf8' })
  const testOutput = `${tests.stdout ?? ''}${tests.stderr ?? ''}`
    .trimEnd()
    .split('\n')
    .slice(-TEST_OUTPUT_TAIL)
    .join('\n')
  git('push', '-q', 'origin', branch)
  const compare = `https://github.com/${opts.forkRepo}/compare/${opts.baseBranch}...${branch}`
  const passed = tests.status === 0
  const report = [
    passed
      ? `Upstream merged cleanly into \`${branch}\` and the tests passed. Open the pull request from the compare link.`
      : `Upstream merged into \`${branch}\` but the tests failed (exit ${tests.status}). Do not open the pull request until they pass.`,
    `Compare: ${compare}`,
    commits,
    `Test command \`${opts.testCommand}\`, last ${TEST_OUTPUT_TAIL} lines:\n\n${fenced(testOutput)}`,
  ].join('\n\n')
  const title = `Upstream merge ${opts.date}: ${passed ? 'ready for a pull request' : 'tests failed'}`
  return openIssue(opts, env, { outcome: passed ? 'ready' : 'tests-failed', report, branch }, title)
}

function openIssue(opts: SyncOptions, env: NodeJS.ProcessEnv, result: SyncResult, title: string): SyncResult {
  const issueUrl = execFileSync(
    opts.gh ?? 'gh',
    ['issue', 'create', '--repo', opts.forkRepo, '--title', title, '--body', result.report],
    { cwd: opts.repoDir, env, encoding: 'utf8' },
  ).trim()
  return { ...result, issueUrl }
}

function fenced(text: string): string {
  return `\`\`\`\n${text.replaceAll('```', "'''")}\n\`\`\``
}

function argument(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  const upstreamUrl = argument(argv, '--upstream')
  const forkRepo = argument(argv, '--repo')
  if (!upstreamUrl || !forkRepo) {
    console.error('usage: upstreamSync.ts --upstream <url> --repo <owner/name> [--base main] [--test "<cmd>"]')
    process.exit(64)
  }
  const result = syncUpstream({
    repoDir: process.cwd(),
    upstreamUrl,
    forkRepo,
    baseBranch: argument(argv, '--base') ?? 'main',
    date: new Date().toISOString().slice(0, 10),
    testCommand: argument(argv, '--test') ?? 'bun run test',
  })
  console.log(`${result.outcome}${result.issueUrl ? ` ${result.issueUrl}` : ''}\n\n${result.report}`)
  process.exit(result.outcome === 'up-to-date' || result.outcome === 'ready' ? 0 : 1)
}
