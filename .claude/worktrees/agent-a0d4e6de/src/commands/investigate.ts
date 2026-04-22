import type { CliContext } from '../types'

export default async function run(ctx: CliContext): Promise<void> {
  if (ctx.json) {
    console.log(JSON.stringify({ command: 'investigate', status: 'not_implemented' }))
  } else {
    console.log('investigate: not yet implemented')
  }
}
