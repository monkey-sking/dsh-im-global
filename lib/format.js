/**
 * Platform text formatting.
 *
 * One model answer has to become three different dialects: Discord markdown,
 * Slack mrkdwn, and Matrix plain text. Everything structural is shared —
 * tables are drawn as monospace blocks, headings become bold lines, bullets use
 * a glyph — and only the emphasis markers differ.
 *
 * The lesson borrowed from the noagent plugin: never leave a raw pipe table or
 * a `##` heading in a chat message, because on a phone it wraps into noise the
 * user reads as corruption.
 */

/** Display width of one character in a monospace client (CJK counts as two). */
export function displayWidth(char) {
  const code = char.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff);
  return wide ? 2 : 1;
}

/** Neutralize mass-ping syntax a model answer might quote. */
export function escapeMentions(text, style) {
  let out = String(text);
  if (style === 'slack') {
    // Slack pings on <!channel> / <!here>; strip the angle form entirely.
    out = out.replace(/<!(channel|here|everyone)>/gi, (_, word) => `\u200b!${word}`);
  } else {
    out = out.replace(/@(everyone|here)\b/gi, (_, word) => `@\u200b${word}`);
    out = out.replace(/@room\b/gi, '@\u200broom');
  }
  return out;
}

/** Rewrite the HTML some models emit into markdown-ish markers. */
export function htmlToText(text) {
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(\/)?(b|strong)>/gi, '**')
    .replace(/<(\/)?(i|em)>/gi, '*')
    .replace(/<(\/)?(s|del|strike)>/gi, '~~')
    .replace(/<(\/)?u>/gi, '__')
    .replace(/<(\/)?code>/gi, '`')
    .replace(/<(\/)?pre>/gi, '```')
    .replace(/<\/?[a-z][^>]*>/gi, '');
}

function isTableSeparator(line) {
  if (typeof line !== 'string') return false;
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** Draw a markdown table as an aligned monospace block. */
export function renderTable(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return String(lines ?? '').join('\n');
  const header = splitRow(lines[0]);
  const body = lines.slice(2).map(splitRow);
  const columns = Math.max(header.length, ...body.map((row) => row.length));
  const width = (text) => [...String(text)].reduce((sum, ch) => sum + displayWidth(ch), 0);

  const widths = [];
  for (let col = 0; col < columns; col += 1) {
    let widest = width(header[col] ?? '');
    for (const row of body) widest = Math.max(widest, width(row[col] ?? ''));
    widths.push(widest);
  }
  const pad = (text, col) => {
    const missing = widths[col] - width(text);
    return missing > 0 ? text + ' '.repeat(missing) : text;
  };
  const line = (cells) =>
    cells
      .map((cell, col) => (col === cells.length - 1 ? String(cell ?? '') : pad(String(cell ?? ''), col)))
      .join(' | ')
      .trimEnd();

  return ['```', line(header), ...body.map(line), '```'].join('\n');
}

/**
 * Convert one model answer into a platform's dialect.
 *
 * @param {string} source model markdown
 * @param {'discord'|'slack'|'matrix'} style target dialect
 */
export function formatFor(source, style = 'discord') {
  const text = htmlToText(String(source ?? '')).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  const fences = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      fences.push(`${marker}\n${body.join('\n')}\n${marker}`);
      out.push(`\u0000FENCE${fences.length - 1}\u0000`);
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const table = [line];
      index += 1;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        table.push(lines[index]);
        index += 1;
      }
      index -= 1;
      out.push(renderTable(table));
      continue;
    }

    out.push(line);
  }

  let rendered = out.join('\n');
  rendered = rendered.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '**$1**');
  rendered = rendered.replace(/(^|[^*\w])\*\*(?=\S)([^*\n]*?\S)\*\*(?![*\w])/g, '$1**$2**');
  rendered = rendered.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  rendered = rendered.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) =>
    alt ? `[${alt}](${url})` : url,
  );

  // Slack uses *bold* rather than **bold**, and has no !!strike!!.
  if (style === 'slack') {
    rendered = rendered
      .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '*$1*')
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '~$1~');
  }

  rendered = rendered.replace(/\u0000FENCE(\d+)\u0000/g, (_, slot) => fences[Number(slot)] ?? '');
  return escapeMentions(rendered, style).trim();
}

/**
 * Split a rendered answer into platform-sized messages.
 *
 * Splits on line boundaries so a fence or table is not cut mid-row; a single
 * oversized line is hard-split as a last resort.
 */
export function splitMessage(text, limit) {
  const source = String(text ?? '');
  if (!Number.isFinite(limit) || limit <= 0) return [source.trim()].filter(Boolean);
  if (source.length <= limit) return source.trim() ? [source.trim()] : [];

  const chunks = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trimEnd());
    current = '';
  };

  for (const line of source.split('\n')) {
    if (line.length > limit) {
      flush();
      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      flush();
      current = line;
    } else {
      current = next;
    }
  }
  flush();
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** Cap a streaming preview without cutting a surrogate pair in half. */
export function toPreview(text, limit) {
  const source = String(text ?? '');
  if (source.length <= limit) return source;
  let cut = limit;
  const code = source.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${source.slice(0, cut)}\n…`;
}
