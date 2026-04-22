import type { CliContext } from '../types'

export default async function run(ctx: CliContext): Promise<void> {
  if (ctx.json) {
    console.log(JSON.stringify({ command: 'refs', status: 'not_implemented' }))
  } else {
    console.log('refs: not yet implemented')
  }
}
