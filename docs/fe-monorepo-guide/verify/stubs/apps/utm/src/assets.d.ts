declare module '*.png' {
  const source: string
  export default source
}
interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly MODE?: string }
}
