// code-spider-xof
// Bun `with { type: 'text' }` imports resolve to the file's contents.
declare module '*.yaml' {
  const text: string
  export default text
}
