import { basename, extname } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Database } from 'bun:sqlite'

interface MarkdownUnitRow {
  id: number
  key: string
  path: string | null
  label: string
}

interface CodeUnitRow {
  id: number
  key: string
  path: string | null
  label: string
}

interface ParsedSection {
  title: string
  slug: string
  level: number
  body: string
  mentionPaths: string[]
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function classifyDoc(path: string): string {
  const base = basename(path).toLowerCase()
  if (base === 'readme.md' || base === 'readme.mdx') return 'readme'
  if (base.includes('adr')) return 'adr'
  if (base.includes('runbook')) return 'runbook'
  if (base.includes('spec') || base.includes('prd')) return 'spec'
  if (base.includes('architecture')) return 'architecture-note'
  return 'markdown'
}

function summarizeSectionBody(lines: string[]): string {
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ')
    .slice(0, 500)
}

function extractMentionPaths(text: string, candidates: string[]): string[] {
  const mentions: string[] = []
  for (const candidate of candidates) {
    if (candidate.length < 3) continue
    if (text.includes(candidate)) {
      mentions.push(candidate)
    }
  }
  return mentions
}

function parseMarkdownSections(text: string, candidatePaths: string[]): ParsedSection[] {
  const lines = text.split(/\r?\n/)
  const sections: ParsedSection[] = []
  let currentTitle = 'Overview'
  let currentLevel = 1
  let currentLines: string[] = []
  let headingIndex = 0

  const flush = (): void => {
    const body = summarizeSectionBody(currentLines)
    if (body === '' && currentTitle === 'Overview') return
    const slugBase = slugify(currentTitle) || `section-${headingIndex}`
    sections.push({
      title: currentTitle,
      slug: slugBase,
      level: currentLevel,
      body,
      mentionPaths: extractMentionPaths(currentLines.join('\n'), candidatePaths),
    })
  }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      headingIndex++
      currentTitle = heading[2] ?? `Section ${headingIndex}`
      currentLevel = heading[1]?.length ?? 1
      currentLines = []
      continue
    }
    currentLines.push(line)
  }

  flush()
  return sections
}

export interface MarkdownContextResult {
  docsAdded: number
  sectionsAdded: number
  mentionEdgesAdded: number
}

export class MarkdownContextIndexer {
  run(db: Database, runId: number, repoRoot: string): MarkdownContextResult {
    const markdownUnits = db.query<MarkdownUnitRow, [number]>(
      `SELECT id, key, path, label
       FROM nodes
       WHERE run_id=? AND kind='unit' AND language='Markdown'
       ORDER BY path ASC`
    ).all(runId)

    if (markdownUnits.length === 0) {
      return { docsAdded: 0, sectionsAdded: 0, mentionEdgesAdded: 0 }
    }

    const codeUnits = db.query<CodeUnitRow, [number]>(
      `SELECT id, key, path, label
       FROM nodes
       WHERE run_id=? AND kind='unit' AND path IS NOT NULL`
    ).all(runId)
    const pathToUnit = new Map(codeUnits.flatMap(unit => unit.path ? [[unit.path, unit]] : []))
    const candidatePaths = [...pathToUnit.keys()]

    const insertNode = db.prepare(
      `INSERT OR IGNORE INTO nodes (run_id, kind, key, label, path, language, summary, confidence, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    const getNodeId = db.prepare(
      'SELECT id FROM nodes WHERE run_id=? AND kind=? AND key=?'
    )
    const insertEdge = db.prepare(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight, metadata_json)
       VALUES (?,?,?,?,?,?)`
    )
    const insertEvidence = db.prepare(
      `INSERT INTO evidence (run_id, node_id, edge_id, kind, source, locator, snippet, score)
       VALUES (?,?,?,?,?,?,?,?)`
    )

    let docsAdded = 0
    let sectionsAdded = 0
    let mentionEdgesAdded = 0

    for (const unit of markdownUnits) {
      if (unit.path === null) continue
      const docKey = `doc:${unit.path}`
      const docLabel = basename(unit.path)
      const docType = classifyDoc(unit.path)

      let raw = ''
      try {
        raw = readFileSync(`${repoRoot}/${unit.path}`, 'utf8')
      } catch {
        continue
      }

      insertNode.run(
        runId,
        'doc',
        docKey,
        docLabel,
        unit.path,
        'Markdown',
        null,
        0.8,
        JSON.stringify({ docType, sourceUnitKey: unit.key, extension: extname(unit.path) }),
      )
      docsAdded++

      const docNodeRow = getNodeId.get(runId, 'doc', docKey) as { id: number } | undefined
      if (docNodeRow === undefined) continue

      const docEdge = insertEdge.run(
        runId,
        unit.id,
        docNodeRow.id,
        'documents',
        1,
        JSON.stringify({ source: 'markdown' }),
      )
      insertEvidence.run(
        runId,
        docNodeRow.id,
        Number(docEdge.lastInsertRowid),
        'markdown',
        unit.path,
        null,
        docType,
        1,
      )

      const sections = parseMarkdownSections(raw, candidatePaths)
      for (const [index, section] of sections.entries()) {
        const sectionKey = `doc_section:${unit.path}#${section.slug || `section-${index + 1}`}`
        insertNode.run(
          runId,
          'doc_section',
          sectionKey,
          section.title,
          unit.path,
          'Markdown',
          section.body,
          0.7,
          JSON.stringify({ docKey, level: section.level, order: index }),
        )
        sectionsAdded++

        const sectionNodeRow = getNodeId.get(runId, 'doc_section', sectionKey) as { id: number } | undefined
        if (sectionNodeRow === undefined) continue

        const sectionEdge = insertEdge.run(
          runId,
          docNodeRow.id,
          sectionNodeRow.id,
          'contains',
          1,
          JSON.stringify({ source: 'markdown' }),
        )
        insertEvidence.run(
          runId,
          sectionNodeRow.id,
          Number(sectionEdge.lastInsertRowid),
          'markdown',
          unit.path,
          section.title,
          section.body,
          0.8,
        )

        for (const mentionPath of section.mentionPaths) {
          const mentionedUnit = pathToUnit.get(mentionPath)
          if (mentionedUnit === undefined) continue
          const mentionEdge = insertEdge.run(
            runId,
            sectionNodeRow.id,
            mentionedUnit.id,
            'mentions',
            1,
            JSON.stringify({ source: 'markdown', path: mentionPath }),
          )
          insertEvidence.run(
            runId,
            mentionedUnit.id,
            Number(mentionEdge.lastInsertRowid),
            'markdown',
            unit.path,
            section.title,
            `mentions ${mentionPath}`,
            1,
          )
          mentionEdgesAdded++
        }
      }
    }

    return { docsAdded, sectionsAdded, mentionEdgesAdded }
  }
}
