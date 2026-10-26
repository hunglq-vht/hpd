import { useState } from 'react'

/** README: Keep an initialized value stable for this component's lifetime. */
export function useConstant<T>(initialize: () => T): T {
  const [value] = useState(initialize)
  return value
}
