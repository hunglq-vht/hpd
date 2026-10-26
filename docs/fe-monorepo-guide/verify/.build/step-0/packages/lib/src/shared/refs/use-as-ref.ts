import * as React from 'react'

export function useAsRef<T>(props: T): React.RefObject<T> {
  const ref = React.useRef(props)
  React.useLayoutEffect(function syncLatestRef() {
    ref.current = props
  })
  return ref
}
