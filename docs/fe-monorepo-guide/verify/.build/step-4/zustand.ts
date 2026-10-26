// Minimal zustand stub: create()(initializer) returns a hook with getState/subscribe.
type SetState<T> = (partial: Partial<T>) => void
export function create<T>() {
  return (initializer: (set: SetState<T>, get: () => T) => T) => {
    const listeners = new Set<(state: T, previous: T) => void>()
    let state: T
    const set: SetState<T> = partial => {
      const previous = state
      state = { ...state, ...partial }
      for (const listener of listeners) listener(state, previous)
    }
    state = initializer(set, () => state)
    return Object.assign(<U>(select: (s: T) => U): U => select(state), {
      getState: () => state,
      subscribe: (listener: (state: T, previous: T) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    })
  }
}
