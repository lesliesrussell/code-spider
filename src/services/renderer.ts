/// <reference types="bun" />
// code-spider-7ui
import type { CliContext } from '../types'

export interface ErrorOptions {
  hint?: string
  exitCode?: number
}

export class Renderer {
  private readonly json: boolean

  constructor(ctx: CliContext) {
    this.json = ctx.json ?? false
  }

  error(message: string, options: ErrorOptions | number = 1): never {
    const exitCode = typeof options === 'number' ? options : (options.exitCode ?? 1)
    const hint = typeof options === 'object' ? options.hint : undefined

    if (this.json) {
      const payload: any = { error: message }
      if (hint) payload.hint = hint
      console.log(JSON.stringify(payload, null, 2))
    } else {
      console.error(message)
      if (hint) {
        console.error(`\nHint: ${hint}`)
      }
    }

    process.exit(exitCode)
    throw new Error('unreachable')
  }

  jsonOutput(data: unknown): void {
    console.log(JSON.stringify(data, null, 2))
  }

  heading(text: string): void {
    if (this.json) return
    console.log(text)
    console.log()
  }

  subheading(text: string): void {
    if (this.json) return
    console.log(text)
  }

  line(text: string = ''): void {
    if (this.json) return
    console.log(text)
  }

  keyValue(key: string, value: string | number): void {
    if (this.json) return
    console.log(`  ${key.padEnd(16)} ${value}`)
  }

  list(items: string[], title?: string): void {
    if (this.json) return
    if (title) {
      this.subheading(title)
    }
    for (const item of items) {
      console.log(`  ${item}`)
    }
    this.line()
  }

  table(rows: Array<{ [key: string]: string | number }>, title?: string): void {
    if (this.json) return
    if (title) this.subheading(title)
    for (const row of rows) {
      const parts = Object.entries(row).map(([k, v]) => `${k}: ${v}`)
      console.log(`  ${parts.join('  ')}`)
    }
    this.line()
  }

  render<T>(data: T, humanRenderer: (data: T) => void): void {
    if (this.json) {
      this.jsonOutput(data)
      return
    }
    humanRenderer(data)
  }
}
