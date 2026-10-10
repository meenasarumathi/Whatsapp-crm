import { promises as fs, type Dirent } from "fs";
import path from "path";

// ============================================================
// Loads the user guide from the top-level `Guide/` folder.
//
//   Guide/NN-topic.md                      → chapters, ordered by filename
//   Guide/updates/YYYY-MM-DD-name/README.md → "What's new", newest first
//   Guide/updates/YYYY-MM-DD-*.md          → (legacy single-file update)
//
// Every CRM change gets its own folder under `updates/`, so screenshots,
// SQL or notes for that change can live next to its write-up. Only the
// folder's README.md is rendered. README.md at a folder root and anything
// starting with `_` (e.g. _TEMPLATE) are skipped. Adding a guide page is just dropping a file in the folder —
// no code change. The folder is traced into the standalone build via
// `outputFileTracingIncludes` in next.config.ts.
// ============================================================

export interface GuideDoc {
  /** URL-safe id used in `/guide?topic=` — the filename without `.md`. */
  slug: string;
  title: string;
  summary: string;
  /** Raw markdown body with the leading `# Title` line removed. */
  body: string;
  /** Only set for updates: the YYYY-MM-DD prefix of the filename. */
  date?: string;
}

export interface GuideIndex {
  chapters: GuideDoc[];
  updates: GuideDoc[];
}

const GUIDE_DIR = path.join(process.cwd(), "Guide");
const UPDATES_DIR = path.join(GUIDE_DIR, "updates");

function isGuideFile(name: string): boolean {
  return (
    name.endsWith(".md") &&
    !name.startsWith("_") &&
    name.toLowerCase() !== "readme.md"
  );
}

/** Pull the `# Title` and the first paragraph out of a markdown file. */
export function parseGuideDoc(slug: string, raw: string): GuideDoc {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let title = slug;
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l));
  if (titleIdx !== -1) {
    title = lines[titleIdx].replace(/^#\s+/, "").trim();
    lines.splice(titleIdx, 1);
  }
  const body = lines.join("\n").trim();

  // Summary = first plain paragraph (not a heading, list, table or quote).
  let summary = "";
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    if (text && !/^(#|-|\*|\d+\.|\||>)/.test(text)) {
      summary = text.replace(/\s*\n\s*/g, " ");
      break;
    }
  }

  const date = /^(\d{4}-\d{2}-\d{2})/.exec(slug)?.[1];
  return { slug, title, summary, body, date };
}

async function readDocs(dir: string): Promise<GuideDoc[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const docs = await Promise.all(
    names.filter(isGuideFile).map(async (name) => {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      return parseGuideDoc(name.replace(/\.md$/, ""), raw);
    }),
  );
  return docs.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Updates: one folder per change (`YYYY-MM-DD-name/README.md`), with the
 * older single-file form still accepted. The slug is the folder name.
 */
async function readUpdates(dir: string): Promise<GuideDoc[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const docs = await Promise.all(
    entries.map(async (entry): Promise<GuideDoc | null> => {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) return null;
      if (entry.isDirectory()) {
        try {
          const raw = await fs.readFile(
            path.join(dir, entry.name, "README.md"),
            "utf8",
          );
          return parseGuideDoc(entry.name, raw);
        } catch {
          return null;
        }
      }
      if (!isGuideFile(entry.name)) return null;
      const raw = await fs.readFile(path.join(dir, entry.name), "utf8");
      return parseGuideDoc(entry.name.replace(/\.md$/, ""), raw);
    }),
  );
  return docs
    .filter((d): d is GuideDoc => d !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function loadGuide(): Promise<GuideIndex> {
  const [chapters, updates] = await Promise.all([
    readDocs(GUIDE_DIR),
    readUpdates(UPDATES_DIR),
  ]);
  return { chapters, updates: updates.reverse() };
}
