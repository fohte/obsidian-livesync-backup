import { execFile } from 'node:child_process'
import { posix, resolve } from 'node:path'
import { promisify } from 'node:util'

import { err, ok, type Result, ResultAsync } from 'neverthrow'

import { type ApplyBlob, ApplyError, type ApplyFileChange } from '#apply'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 64 * 1024 * 1024

class GitCommandError extends ApplyError {
  override readonly name: string = 'GitCommandError'

  constructor(
    readonly operation: string,
    readonly exitCode: number | undefined,
    cause: unknown,
  ) {
    super(`git operation failed: ${operation}`, { operation })
    this.cause = cause
  }
}

const runGit = async (
  checkoutPath: string,
  args: readonly string[],
  operation: string,
  encoding: 'utf8' | 'buffer' = 'utf8',
): Promise<Result<string | Buffer, ApplyError>> => {
  const absoluteCheckoutPath = resolve(checkoutPath)
  return ResultAsync.fromPromise(
    execFileAsync(
      'git',
      [
        '-c',
        `safe.directory=${absoluteCheckoutPath}`,
        '-C',
        absoluteCheckoutPath,
        ...args,
      ],
      { encoding, maxBuffer: MAX_GIT_OUTPUT },
    ).then((result) => result.stdout),
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
}

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

const readBlobReference = async (
  checkoutPath: string,
  tree: string,
  path: string,
  objectFormat: ApplyBlob['objectFormat'],
): Promise<Result<ApplyBlob, ApplyError>> => {
  const output = await runGit(
    checkoutPath,
    ['rev-parse', '--verify', '--end-of-options', `${tree}:${path}`],
    'resolve_blob',
  )
  const oidText = text(output)
  if (oidText.isErr()) return err(oidText.error)
  const objectId = oidText.value.trim()
  const expectedLength = objectFormat === 'sha1' ? 40 : 64
  if (!new RegExp(`^[0-9a-f]{${expectedLength.toString()}}$`).test(objectId)) {
    return err(new ApplyError('git returned an invalid blob object id'))
  }

  return ok({
    objectId,
    objectFormat,
    read: async () => {
      const content = bytes(
        await runGit(
          checkoutPath,
          ['cat-file', 'blob', objectId],
          'read_blob',
          'buffer',
        ),
      )
      return content.mapErr(
        (cause) =>
          new ApplyError(cause.message, {
            path,
            operation: 'read_git_blob',
          }),
      )
    },
  })
}

export const loadApplyChanges = async (
  input: LoadChangesInput,
): Promise<Result<readonly ApplyFileChange[], ApplyError>> => {
  const normalizedVaultDir = posix
    .normalize(input.vaultDir)
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
  const vaultDir = normalizedVaultDir === '.' ? '' : normalizedVaultDir
  if (
    input.vaultDir.trim().length === 0 ||
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

  const objectFormatOutput = await runGit(
    input.checkoutPath,
    ['rev-parse', '--show-object-format'],
    'read_object_format',
  )
  const objectFormatText = text(objectFormatOutput)
  if (objectFormatText.isErr()) return err(objectFormatText.error)
  const objectFormat = objectFormatText.value.trim()
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    return err(new ApplyError('unsupported git object format'))
  }

  const commitsOutput = await runGit(
    input.checkoutPath,
    [
      'rev-list',
      '--reverse',
      '--topo-order',
      '--no-merges',
      `${input.from}..${input.to}`,
    ],
    'list_commits',
  )
  const commitsText = text(commitsOutput)
  if (commitsText.isErr()) return err(commitsText.error)

  const changes: ApplyFileChange[] = []
  const commits = commitsText.value.split(/\r?\n/).filter(Boolean)
  const pathspec = vaultDir.length === 0 ? '.' : vaultDir
  const pathPrefix = vaultDir.length === 0 ? '' : `${vaultDir}/`
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
        pathspec,
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

      if (!repositoryPath.startsWith(pathPrefix)) continue
      const path = repositoryPath.slice(pathPrefix.length)
      if (path.length === 0) continue

      let before: ApplyBlob | undefined
      if (status !== 'A') {
        const result = await readBlobReference(
          input.checkoutPath,
          parent,
          repositoryPath,
          objectFormat,
        )
        if (result.isErr()) return err(result.error)
        before = result.value
      }
      let after: ApplyBlob | undefined
      if (status !== 'D') {
        const result = await readBlobReference(
          input.checkoutPath,
          commit,
          repositoryPath,
          objectFormat,
        )
        if (result.isErr()) return err(result.error)
        after = result.value
      }

      changes.push({
        commit: commit.slice(0, 12),
        path,
        before,
        after,
      })
    }
  }
  return ok(changes)
}
