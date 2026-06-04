// code-spider-sgm
// One definition of "is this a test file" — reachability, manifest rules,
// and tested-by derivation were each growing their own copy.
export const TEST_PATH = /(\.test\.|\.spec\.)|(^|\/)(test|tests|__tests__)\//

export const TEST_SUFFIX = /\.(test|spec)\.(ts|tsx|js|jsx)$/

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}
