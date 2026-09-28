type FixtureFields<T> = T extends readonly (infer U)[] ? FixtureFields<U>[] : T extends object ? { [K in keyof T]?: FixtureFields<T[K]> } : T

/** Rendering tests supply only the response fields their scenario observes.
 * The boundary keeps field names/types checked without inventing unrelated server data.
 */
export function responseFixture<T>(value: FixtureFields<T>): T {
  return value as T
}

/** A failed DOM/async setup should fail the test immediately, not weaken its types. */
export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected the test fixture to exist')
  return value
}
