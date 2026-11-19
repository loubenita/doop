/**
 * Daily merge of upstream Doop (kgoedecke/doop) into this fork.
 *
 * Merges upstream main into a dated `upstream-sync/<date>` branch cut from the fork's main, runs the
 * tests on the merged tree, pushes the branch and opens a pull request into main whose description
 * is the report (compare link, upstream commits, test result); a draft when the tests failed. The
 * same report goes to the run summary every time, so it survives a repository that does not let
 * GitHub Actions open pull requests (the summary then carries a link to open one by hand) and a
 * merge conflict, which stops before anything is pushed. Nothing is merged into main and nothing
 * is deployed: a person reviews and merges the pull request.
 *
 * Run by .github/workflows/upstream-sync.yml every day, inside a checkout of the fork:
 *   bun x tsx scripts/upstreamSync.ts --upstream <url> --repo <owner/name> [--base main] [--test "<cmd>"]
 */

import { appendFileSync } from 'node:fs'
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
  /** where the report is appended for the run page ($GITHUB_STEP_SUMMARY) */
  summaryFile?: string
  /** extra environment for git and the test command */
  env?: Record<string, string>
}

export type SyncOutcome = 'up-to-date' | 'ready' | 'conflict' | 'tests-failed'

export interface SyncResult {
  outcome: SyncOutcome
  report: string
  branch?: string
  pullRequestUrl?: string
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
    const report = `Upstream main ${upstreamHead.slice(0, 7)} is already in ${base}.`
    return summarise(opts, { outcome: 'up-to-date', report })
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
    return summarise(opts, { outcome: 'conflict', report })
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
  const title = `Upstream merge ${opts.date}: ${passed ? 'ready to review' : 'tests failed'}`
  const result: SyncResult = { outcome: passed ? 'ready' : 'tests-failed', report, branch }
  return summarise(opts, openPullRequest(opts, env, result, branch, title, compare))
}

/** Opens the pull request from the pushed branch; a refusal goes into the report, never stops it. */
function openPullRequest(
  opts: SyncOptions,
  env: NodeJS.ProcessEnv,
  result: SyncResult,
  branch: string,
  title: string,
  compare: string,
): SyncResult {
  const args = ['pr', 'create', '--repo', opts.forkRepo, '--base', opts.baseBranch, '--head', branch]
  if (result.outcome !== 'ready') args.push('--draft')
  const created = spawnSync(opts.gh ?? 'gh', [...args, '--title', title, '--body', result.report], {
    cwd: opts.repoDir,
    env,
    encoding: 'utf8',
  })
  if (created.status === 0) {
    const pullRequestUrl = created.stdout.trim()
    return { ...result, pullRequestUrl, report: `Pull request: ${pullRequestUrl}\n\n${result.report}` }
  }
  const refusal = `${created.stderr ?? ''}${created.error?.message ?? ''}`.trim()
  const report = [
    `The pull request could not be opened: ${refusal}`,
    `Open it by hand: ${compare}?expand=1`,
    result.report,
  ].join('\n\n')
  return { ...result, report }
}

function summarise(opts: SyncOptions, result: SyncResult): SyncResult {
  if (opts.summaryFile) appendFileSync(opts.summaryFile, `## Upstream merge ${opts.date}\n\n${result.report}\n`)
  return result
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
    summaryFile: process.env.GITHUB_STEP_SUMMARY,
  })
  console.log(`${result.outcome}${result.pullRequestUrl ? ` ${result.pullRequestUrl}` : ''}\n\n${result.report}`)
  process.exit(result.outcome === 'up-to-date' || result.outcome === 'ready' ? 0 : 1)
}
