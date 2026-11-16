import { execFile } from 'node:child_process'
import { posix } from 'node:path'
import { promisify } from 'node:util'

import { err, ok, type Result, ResultAsync } from 'neverthrow'

import { ApplyError, type ApplyFileChange } from '#apply'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 64 * 1024 * 1024

class GitCommandError extends ApplyError {
  override readonly name: string = 'GitCommandError'

  constructor(
    readonly operation: string,
    readonly exitCode: number | undefined,
    cause: unknown,
  ) {
    super(`git operation failed: ${operation}`)
    this.cause = cause
  }
}

const runGit = async (
  checkoutPath: string,
  args: readonly string[],
  operation: string,
  encoding: 'utf8' | 'buffer' = 'utf8',
): Promise<Result<string | Buffer, ApplyError>> =>
  ResultAsync.fromPromise(
    execFileAsync('git', ['-C', checkoutPath, ...args], {
      encoding,
      maxBuffer: MAX_GIT_OUTPUT,
    }).then((result) => result.stdout),
    (cause) =>
      new GitCommandError(
        operation,
        typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          typeof cause.code === 'number'
          ? cause.code
          : undefined,
        cause,
      ),
  )

const text = (
  result: Result<string | Buffer, ApplyError>,
): Result<string, ApplyError> =>
  result.andThen((output) =>
    typeof output === 'string'
      ? ok(output)
      : err(new ApplyError('unexpected binary git output')),
  )

const bytes = (
  result: Result<string | Buffer, ApplyError>,
): Result<Buffer, ApplyError> =>
  result.andThen((output) =>
    Buffer.isBuffer(output)
      ? ok(output)
      : err(new ApplyError('unexpected text git output')),
  )

export interface LoadChangesInput {
  readonly checkoutPath: string
  readonly from: string
  readonly to: string
  readonly vaultDir: string
  readonly excludedAuthorEmail: string
}

const readBlob = async (
  checkoutPath: string,
  tree: string,
  path: string,
): Promise<Result<Buffer, ApplyError>> => {
  const output = await runGit(
    checkoutPath,
    ['cat-file', 'blob', `${tree}:${path}`],
    'read_blob',
    'buffer',
  )
  return bytes(output)
}

export const loadApplyChanges = async (
  input: LoadChangesInput,
): Promise<Result<readonly ApplyFileChange[], ApplyError>> => {
  const vaultDir = posix
    .normalize(input.vaultDir)
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
  if (
    vaultDir.length === 0 ||
    vaultDir.startsWith('/') ||
    vaultDir === '..' ||
    vaultDir.startsWith('../')
  ) {
    return err(new ApplyError('vault directory must be inside the checkout'))
  }

  const ancestor = await runGit(
    input.checkoutPath,
    ['merge-base', '--is-ancestor', input.from, input.to],
    'check_ancestor',
  )
  if (ancestor.isErr()) {
    if (
      ancestor.error instanceof GitCommandError &&
      ancestor.error.exitCode === 1
    ) {
      return err(new ApplyError('from commit is not an ancestor of to commit'))
    }
    return err(ancestor.error)
  }

  const commitsOutput = await runGit(
    input.checkoutPath,
    [
      'rev-list',
      '--reverse',
      '--topo-order',
      '--ancestry-path',
      `${input.from}..${input.to}`,
    ],
    'list_commits',
  )
  const commitsText = text(commitsOutput)
  if (commitsText.isErr()) return err(commitsText.error)

  const changes: ApplyFileChange[] = []
  const commits = commitsText.value.split(/\r?\n/).filter(Boolean)
  for (const commit of commits) {
    const authorOutput = await runGit(
      input.checkoutPath,
      ['show', '-s', '--format=%ae', commit],
      'read_author',
    )
    const authorText = text(authorOutput)
    if (authorText.isErr()) return err(authorText.error)
    if (authorText.value.trim() === input.excludedAuthorEmail) continue

    const parentOutput = await runGit(
      input.checkoutPath,
      ['rev-parse', `${commit}^1`],
      'read_parent',
    )
    const parentText = text(parentOutput)
    if (parentText.isErr()) return err(parentText.error)
    const parent = parentText.value.trim()

    const namesOutput = await runGit(
      input.checkoutPath,
      [
        'diff',
        '--no-ext-diff',
        '--no-renames',
        '--name-status',
        '-z',
        parent,
        commit,
        '--',
        vaultDir,
      ],
      'list_changed_files',
    )
    const namesText = text(namesOutput)
    if (namesText.isErr()) return err(namesText.error)
    const tokens = namesText.value.split('\0').filter(Boolean)

    for (let index = 0; index < tokens.length;) {
      const status = tokens[index]
      const repositoryPath = tokens[index + 1]
      if (status === undefined || repositoryPath === undefined) {
        return err(new ApplyError('invalid git diff output'))
      }
      index += 2

      const prefix = `${vaultDir}/`
      if (!repositoryPath.startsWith(prefix)) continue
      const path = repositoryPath.slice(prefix.length)
      if (path.length === 0) continue

      const before =
        status === 'A'
          ? undefined
          : await readBlob(input.checkoutPath, parent, repositoryPath)
      if (before !== undefined && before.isErr()) return err(before.error)
      const after =
        status === 'D'
          ? undefined
          : await readBlob(input.checkoutPath, commit, repositoryPath)
      if (after !== undefined && after.isErr()) return err(after.error)

      changes.push({
        commit: commit.slice(0, 12),
        path,
        before: before === undefined ? undefined : before.value,
        after: after === undefined ? undefined : after.value,
      })
    }
  }
  return ok(changes)
}
