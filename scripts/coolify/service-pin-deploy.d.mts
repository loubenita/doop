export function swapPin(
  compose: string,
  from: string,
  to: string,
): { compose: string; diff: { line: number; before: string; after: string } }

export function run(
  argv: string[],
  deps: {
    env: Record<string, string | undefined>
    fetch: unknown
    log: (line: string) => void
    sleep: (ms: number) => Promise<void>
    now: () => number
  },
): Promise<number>
