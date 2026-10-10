import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Lightbulb } from "lucide-react";

import {
  parseInline,
  type Block,
  type Inline,
  type ListBlock,
} from "@/lib/guide/markdown";

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>;
      case "bold":
        return (
          <strong key={i} className="font-semibold text-foreground">
            {renderInline(node.children)}
          </strong>
        );
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
          >
            {node.text}
          </code>
        );
      case "link": {
        const className =
          "font-medium text-primary underline-offset-4 hover:underline";
        return node.href.startsWith("http") ? (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
          >
            {renderInline(node.children)}
          </a>
        ) : (
          <Link key={i} href={node.href} className={className}>
            {renderInline(node.children)}
          </Link>
        );
      }
    }
  });
}

const inline = (text: string) => renderInline(parseInline(text));

function GuideList({ list, nested = false }: { list: ListBlock; nested?: boolean }) {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag
      className={
        (list.ordered ? "list-decimal" : "list-disc") +
        " space-y-1.5 pl-5 marker:text-muted-foreground" +
        (nested ? " mt-1.5" : "")
      }
    >
      {list.items.map((item, i) => (
        <li key={i} className="pl-1">
          {inline(item.text)}
          {item.children ? <GuideList list={item.children} nested /> : null}
        </li>
      ))}
    </Tag>
  );
}

export function GuideMarkdown({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            if (block.level === 3) {
              return (
                <h4
                  key={i}
                  id={block.id}
                  className="scroll-mt-4 pt-2 text-sm font-semibold text-foreground"
                >
                  {inline(block.text)}
                </h4>
              );
            }
            return (
              <h3
                key={i}
                id={block.id}
                className="scroll-mt-4 border-t border-border pt-6 text-base font-semibold tracking-tight text-foreground first:border-t-0 first:pt-0"
              >
                {inline(block.text)}
              </h3>
            );
          case "paragraph":
            return <p key={i}>{inline(block.text)}</p>;
          case "list":
            return <GuideList key={i} list={block} />;
          case "quote":
            return (
              <div
                key={i}
                className="flex gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-foreground"
              >
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
                <p>{inline(block.text)}</p>
              </div>
            );
          case "table":
            return (
              <div
                key={i}
                className="overflow-x-auto rounded-lg border border-border"
              >
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50 text-foreground">
                    <tr>
                      {block.header.map((cell, c) => (
                        <th key={c} className="px-3 py-2 font-semibold">
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-t border-border align-top">
                        {row.map((cell, c) => (
                          <td key={c} className="px-3 py-2">
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={i} className="border-border" />;
        }
      })}
    </div>
  );
}
