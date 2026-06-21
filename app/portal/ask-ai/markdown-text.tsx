"use client";

/**
 * Tiny markdown renderer for the portal AI chat output.
 *
 * Why not react-markdown? Streaming changes everything. With react-markdown
 * each chunk re-parses the entire growing string, which works but is heavy
 * (~50KB gzipped + multiple plugins) and the parser sometimes flips between
 * states mid-stream causing layout jumps.
 *
 * This component handles exactly the markdown shapes Claude produces in
 * answers about finance:
 *   - **bold**            (most important — Claude uses this a LOT)
 *   - *italic*            (occasional)
 *   - Numbered lists      (1. xxx, 2. xxx)
 *   - Bullet lists        (- xxx, * xxx)
 *   - Paragraph breaks    (blank line between paragraphs)
 *   - Inline `code`       (rare but cheap to support)
 *
 * Streaming safety: partial sequences (e.g. "**bold" without the closing
 * "**") stay as plain text until the closer arrives. No half-rendered HTML.
 *
 * NEVER renders raw HTML — every Claude output goes through escapeHtml first,
 * then we re-inject only the formatting tags we built. Defense against any
 * prompt injection attempt that tries to slip HTML through.
 */

import React from "react";

export function MarkdownText({ children }: { children: string }) {
  const blocks = parseBlocks(children);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === "ol") {
          return (
            <ol key={i} className="list-decimal ml-5 my-2 space-y-1">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline>{item}</Inline>
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={i} className="list-disc ml-5 my-2 space-y-1">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline>{item}</Inline>
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === "table") {
          return (
            <div key={i} className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[13px] text-left">
                <thead>
                  <tr>
                    {block.headers.map((h, j) => (
                      <th key={j} className="border-b border-slate-300 px-2.5 py-1.5 font-semibold text-navy whitespace-nowrap">
                        <Inline>{h}</Inline>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r} className="border-b border-slate-100">
                      {row.map((cell, j) => (
                        <td key={j} className="px-2.5 py-1.5 align-top">
                          <Inline>{cell}</Inline>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        // Paragraph — preserve internal newlines
        return (
          <p key={i} className="my-1 whitespace-pre-wrap">
            <Inline>{block.text}</Inline>
          </p>
        );
      })}
    </>
  );
}

// ─── BLOCK-LEVEL PARSING ────────────────────────────────────────────────

type Block =
  | { type: "p"; text: string }
  | { type: "ol"; items: string[] }
  | { type: "ul"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

/** Split a "| a | b |" row into trimmed cells (drop the leading/trailing empties). */
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return cells;
}
/** A GFM separator row: |---|:--:|---| (dashes/colons/pipes only, at least one dash). */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return /\|/.test(t) && /-/.test(t) && /^\|?[\s:|-]+\|?$/.test(t);
}
/** A table-ish row: starts/ends with a pipe or contains one. */
function isTableRow(line: string): boolean {
  return line.trim().includes("|");
}

function parseBlocks(input: string): Block[] {
  const lines = input.split("\n");
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let currentList: { type: "ol" | "ul"; items: string[] } | null = null;

  const flushParagraph = () => {
    if (buffer.length > 0) {
      const text = buffer.join("\n");
      if (text.trim().length > 0) blocks.push({ type: "p", text });
      buffer = [];
    }
  };
  const flushList = () => {
    if (currentList) {
      blocks.push(currentList);
      currentList = null;
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // Table: a row immediately followed by a |---|---| separator. Consume the
    // header, the separator, and every following pipe row.
    if (isTableRow(line) && li + 1 < lines.length && isTableSeparator(lines[li + 1])) {
      flushParagraph();
      flushList();
      const headers = splitRow(line);
      const rows: string[][] = [];
      let r = li + 2;
      for (; r < lines.length && isTableRow(lines[r]) && lines[r].trim() !== ""; r++) {
        const cells = splitRow(lines[r]);
        // Pad/truncate to the header width so the grid stays rectangular.
        while (cells.length < headers.length) cells.push("");
        rows.push(cells.slice(0, headers.length));
      }
      blocks.push({ type: "table", headers, rows });
      li = r - 1;
      continue;
    }

    const olMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);

    if (olMatch) {
      flushParagraph();
      if (!currentList || currentList.type !== "ol") {
        flushList();
        currentList = { type: "ol", items: [] };
      }
      currentList.items.push(olMatch[2]);
    } else if (ulMatch) {
      flushParagraph();
      if (!currentList || currentList.type !== "ul") {
        flushList();
        currentList = { type: "ul", items: [] };
      }
      currentList.items.push(ulMatch[1]);
    } else if (line.trim() === "") {
      // Blank line — break paragraph/list
      flushParagraph();
      flushList();
    } else {
      flushList();
      buffer.push(line);
    }
  }
  flushParagraph();
  flushList();

  return blocks;
}

// ─── INLINE PARSING ─────────────────────────────────────────────────────

/**
 * Render a single line/paragraph with inline marks. Order matters:
 *   1. Escape any raw HTML in the input
 *   2. Apply bold (longest greedy match)
 *   3. Apply inline code
 *   4. Apply italic (single * — careful not to munch into list markers)
 *
 * Each pass returns a React fragment array so we can compose them without
 * touching dangerouslySetInnerHTML.
 */
function Inline({ children }: { children: string }) {
  return <>{applyMarkdown(children)}</>;
}

function applyMarkdown(text: string): React.ReactNode[] {
  // Step 1: split on **...** for bold. Greedy but won't match across lines.
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let keyCounter = 0;

  const pushPlain = (s: string) => {
    if (!s) return;
    // Then split on inline code ` ` and italic
    out.push(...applyInlineCode(s, keyCounter));
    keyCounter += 100; // pad keys so the recursion doesn't collide
  };

  const boldRe = /\*\*([^*\n]+?)\*\*/g;
  let match: RegExpExecArray | null;
  while ((match = boldRe.exec(text)) !== null) {
    pushPlain(text.slice(cursor, match.index));
    out.push(
      <strong key={`b-${keyCounter++}`} className="font-semibold">
        {applyInlineCode(match[1], keyCounter)}
      </strong>
    );
    keyCounter += 100;
    cursor = match.index + match[0].length;
  }
  pushPlain(text.slice(cursor));

  return out;
}

function applyInlineCode(text: string, keyOffset: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let key = keyOffset;

  const pushPlain = (s: string) => {
    if (s) out.push(...applyItalic(s, key));
    key += 50;
  };

  const codeRe = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codeRe.exec(text)) !== null) {
    pushPlain(text.slice(cursor, match.index));
    out.push(
      <code key={`c-${key++}`} className="px-1 py-0.5 bg-slate-100 rounded text-[12px] font-mono">
        {match[1]}
      </code>
    );
    cursor = match.index + match[0].length;
  }
  pushPlain(text.slice(cursor));

  return out;
}

function applyItalic(text: string, keyOffset: number): React.ReactNode[] {
  // Single * for italic. Match *word* but NOT * at start of line (list bullet)
  // — though by the time we get here, list-marker handling has stripped those.
  // Also skip ** (already handled) — match requires non-* on both sides.
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let key = keyOffset;

  const italicRe = /(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g;
  let match: RegExpExecArray | null;
  while ((match = italicRe.exec(text)) !== null) {
    const before = text.slice(cursor, match.index);
    if (before) out.push(<span key={`t-${key++}`}>{before}</span>);
    out.push(
      <em key={`i-${key++}`} className="italic">
        {match[1]}
      </em>
    );
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail) out.push(<span key={`t-${key++}`}>{tail}</span>);

  return out;
}
