// Stub of @platform/lib/shared/error/handle-error with the real signatures.
export function catchErrorSync<T>(fn: () => T): [undefined, T] | [Error] {
  try {
    return [undefined, fn()]
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error))]
  }
}
export async function catchErrorAsync<T>(fn: () => Promise<T>): Promise<[undefined, T] | [Error]> {
  try {
    return [undefined, await fn()]
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error))]
  }
}
