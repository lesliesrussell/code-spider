import type { CliContext } from '../types'

export default async function run(ctx: CliContext): Promise<void> {
  if (ctx.json) {
    console.log(JSON.stringify({ command: 'doctor', status: 'not_implemented' }))
  } else {
    console.log('doctor: not yet implemented')
  }
}
