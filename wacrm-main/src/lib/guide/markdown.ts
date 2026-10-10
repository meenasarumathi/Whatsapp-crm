// ============================================================
// Minimal markdown → block tree parser for the in-app Guide.
//
// Supports exactly the subset documented in Guide/README.md:
// headings (#–###), paragraphs, bulleted / numbered lists with one
// level of nesting, tables, `>` quotes (rendered as tip boxes) and
// `---` dividers. Inline formatting (bold, code, links) is handled by
// `parseInline`. Pure + dependency-free so it is easy to unit test and
// never emits raw HTML.
// ============================================================

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export interface ListItem {
  text: string;
  children?: ListBlock;
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: ListItem[];
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "hr" }
  | ListBlock;

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  const usedIds = new Map<string, number>();
  let i = 0;

  const uniqueId = (text: string) => {
    const base = slugify(text) || "section";
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text,
        id: uniqueId(text),
      });
      i++;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        parts.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: parts.join(" ").trim() });
      continue;
    }

    if (trimmed.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const row = lines[i].trim();
        // Skip the `| --- | --- |` separator row.
        if (!/^\|[\s:|-]+\|$/.test(row)) rows.push(splitRow(row));
        i++;
      }
      const [header = [], ...body] = rows;
      blocks.push({ type: "table", header, rows: body });
      continue;
    }

    if (LIST_RE.test(line)) {
      const top: ListBlock = {
        type: "list",
        ordered: /\d/.test(LIST_RE.exec(line)![2]),
        items: [],
      };
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) {
          // A non-blank, indented line continues the previous item.
          const cont = lines[i];
          const last = top.items[top.items.length - 1];
          if (cont.trim() && /^\s+/.test(cont) && last) {
            const target = last.children
              ? last.children.items[last.children.items.length - 1]
              : last;
            target.text += " " + cont.trim();
            i++;
            continue;
          }
          break;
        }
        const indent = m[1].length;
        const ordered = /\d/.test(m[2]);
        const item: ListItem = { text: m[3].trim() };
        const last = top.items[top.items.length - 1];
        if (indent >= 2 && last) {
          last.children ??= { type: "list", ordered, items: [] };
          last.children.items.push(item);
        } else {
          top.items.push(item);
        }
        i++;
      }
      blocks.push(top);
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const parts: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      const t = l.trim();
      if (
        !t ||
        /^#{1,3}\s/.test(t) ||
        t.startsWith(">") ||
        t.startsWith("|") ||
        /^-{3,}$/.test(t) ||
        LIST_RE.test(l)
      ) {
        break;
      }
      parts.push(t);
      i++;
    }
    blocks.push({ type: "paragraph", text: parts.join(" ") });
  }

  return blocks;
}

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** Only same-site paths, in-page anchors and http(s) URLs become links. */
export function isSafeHref(href: string): boolean {
  return /^(\/(?!\/)|#|https?:\/\/)/.test(href);
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });

    if (token.startsWith("**")) {
      out.push({ type: "bold", children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith("`")) {
      out.push({ type: "code", text: token.slice(1, -1) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const children = parseInline(link[1]);
      if (isSafeHref(link[2])) {
        out.push({ type: "link", href: link[2], children });
      } else {
        out.push(...children);
      }
    }
    last = start + token.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
