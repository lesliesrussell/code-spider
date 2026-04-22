export class LineCountAdapter {
  async countLines(filePath: string): Promise<number> {
    try {
      const text = await Bun.file(filePath).text()
      let count = 0
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') count++
      }
      // If file is non-empty and doesn't end with newline, count the last line
      if (text.length > 0 && text[text.length - 1] !== '\n') count++
      return count
    } catch {
      return 0
    }
  }
}
