const resolvedColors = new Map<string, string>()

export function getCssColor(colorReference: `var(--color-${string})`): string {
  const cachedColor = resolvedColors.get(colorReference)
  if (cachedColor !== undefined) return cachedColor

  const variableName = colorReference.slice(4, -1)
  if (typeof document === 'undefined') return colorReference

  const color = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim()
  const invalidColor = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && !CSS.supports('color', color)
  if (color === '' || invalidColor) throw new Error(`Missing or invalid CSS color token: ${variableName}`)
  resolvedColors.set(colorReference, color)
  return color
}
