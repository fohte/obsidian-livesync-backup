export const waitForLivesyncReady = (
  ready: Promise<void>,
  timeoutMs: number,
  createTimeoutError: (timeoutMs: number) => Error,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createTimeoutError(timeoutMs))
    }, timeoutMs)
    ready.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  })
