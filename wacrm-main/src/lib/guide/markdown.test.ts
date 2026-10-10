import { describe, expect, it } from "vitest";

import { isSafeHref, parseInline, parseMarkdown } from "./markdown";
import { loadGuide, parseGuideDoc } from "./load";

describe("parseMarkdown", () => {
  it("parses headings with unique ids", () => {
    const blocks = parseMarkdown("## Tips\n\n## Tips\n\n### Sub **bold**");
    expect(blocks).toEqual([
      { type: "heading", level: 2, text: "Tips", id: "tips" },
      { type: "heading", level: 2, text: "Tips", id: "tips-1" },
      { type: "heading", level: 3, text: "Sub **bold**", id: "sub-bold" },
    ]);
  });

  it("joins wrapped paragraph lines", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", text: "one two" },
      { type: "paragraph", text: "three" },
    ]);
  });

  it("nests indented list items under the previous item", () => {
    const [list] = parseMarkdown("1. First\n2. Fill in:\n   - **Title**\n   - Value\n3. Save");
    expect(list).toEqual({
      type: "list",
      ordered: true,
      items: [
        { text: "First" },
        {
          text: "Fill in:",
          children: {
            type: "list",
            ordered: false,
            items: [{ text: "**Title**" }, { text: "Value" }],
          },
        },
        { text: "Save" },
      ],
    });
  });

  it("parses tables and skips the separator row", () => {
    const [table] = parseMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(table).toEqual({ type: "table", header: ["A", "B"], rows: [["1", "2"]] });
  });

  it("parses quotes and dividers", () => {
    expect(parseMarkdown("> **Tip:** one\n> two\n\n---")).toEqual([
      { type: "quote", text: "**Tip:** one two" },
      { type: "hr" },
    ]);
  });
});

describe("parseInline", () => {
  it("handles bold, code and links", () => {
    expect(parseInline("Go to **[Inbox](/inbox)** and type `hi`.")).toEqual([
      { type: "text", text: "Go to " },
      {
        type: "bold",
        children: [{ type: "link", href: "/inbox", children: [{ type: "text", text: "Inbox" }] }],
      },
      { type: "text", text: " and type " },
      { type: "code", text: "hi" },
      { type: "text", text: "." },
    ]);
  });

  it("drops unsafe link targets but keeps the text", () => {
    expect(parseInline("[x](javascript:alert(1))")).not.toContainEqual(
      expect.objectContaining({ type: "link" }),
    );
    expect(isSafeHref("//evil.com")).toBe(false);
    expect(isSafeHref("/settings?tab=whatsapp")).toBe(true);
    expect(isSafeHref("https://developers.facebook.com")).toBe(true);
  });
});

describe("guide loader", () => {
  it("extracts title, summary and date", () => {
    const doc = parseGuideDoc(
      "2026-10-08-thing",
      "# New thing\n\nIt does stuff.\n\n## More\n\nBody",
    );
    expect(doc).toMatchObject({
      title: "New thing",
      summary: "It does stuff.",
      date: "2026-10-08",
    });
    expect(doc.body.startsWith("It does stuff.")).toBe(true);
  });

  it("loads the real Guide folder, skipping README and _ files", async () => {
    const { chapters, updates } = await loadGuide();
    expect(chapters.length).toBeGreaterThan(5);
    expect(chapters[0].slug).toBe("01-getting-started");
    const slugs = [...chapters, ...updates].map((d) => d.slug);
    expect(slugs).not.toContain("README");
    expect(slugs.some((s) => s.startsWith("_"))).toBe(false);
    // Every chapter needs a title and summary for the rail / header.
    for (const doc of [...chapters, ...updates]) {
      expect(doc.title).not.toBe(doc.slug);
      expect(doc.summary).not.toBe("");
    }
  });
});
