import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  KnowledgeDocumentContent,
  KnowledgeDocumentSummary,
  KnowledgeProvider,
  KnowledgeSearchResult,
} from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = __dirname; // knowledge/markdown/ — the .md files live next to this file

// Only simple, flat slugs: letters, digits, hyphen, underscore. No dots, no
// slashes, no leading dash. Rejects "..", absolute paths, and any path
// separator outright, before a path is ever built from user input — this
// closes the path-traversal gap found in the security audit
// ("../../etc/passwd" style slugs).
const SAFE_SLUG = /^[a-zA-Z0-9_-]+$/;

export class UnsafeSlugError extends Error {
  constructor(slug: string) {
    super(`"${slug}" is not a valid document slug.`);
    this.name = "UnsafeSlugError";
  }
}

/**
 * Resolves a slug to a path guaranteed to stay inside DOCS_DIR, or throws.
 * Two independent checks on purpose: the regex rejects the obvious cases
 * cheaply, and the resolved-path containment check is the actual guarantee
 * — belt and suspenders, since regexes are easy to get subtly wrong.
 */
export function resolveSafeDocPath(slug: string): string {
  if (!SAFE_SLUG.test(slug)) {
    throw new UnsafeSlugError(slug);
  }
  const resolved = path.resolve(DOCS_DIR, `${slug}.md`);
  const dirWithSep = DOCS_DIR.endsWith(path.sep) ? DOCS_DIR : DOCS_DIR + path.sep;
  if (!resolved.startsWith(dirWithSep)) {
    throw new UnsafeSlugError(slug);
  }
  return resolved;
}

function slugFromFilename(filename: string): string {
  return filename.replace(/\.md$/, "");
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function extractTags(content: string): string[] {
  const match = content.match(/^tags:\s*\[(.*)\]\s*$/m);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Minimal filesystem-backed knowledge provider. Reads plain Markdown files
 * from knowledge/markdown/. No database, no document-management system —
 * just the abstraction (list/read/search) the rest of Angel OS needs.
 */
export class MarkdownKnowledgeProvider implements KnowledgeProvider {
  async listDocuments(): Promise<KnowledgeDocumentSummary[]> {
    const files = await this.mdFiles();
    const summaries: KnowledgeDocumentSummary[] = [];
    for (const file of files) {
      const content = await readFile(path.join(DOCS_DIR, file), "utf-8");
      summaries.push({
        slug: slugFromFilename(file),
        title: extractTitle(content, slugFromFilename(file)),
        tags: extractTags(content),
      });
    }
    return summaries;
  }

  async readDocument(slug: string): Promise<KnowledgeDocumentContent | null> {
    let filePath: string;
    try {
      filePath = resolveSafeDocPath(slug);
    } catch {
      return null; // an unsafe slug is treated the same as "not found" — no distinguishing signal for an attacker
    }
    try {
      const content = await readFile(filePath, "utf-8");
      return {
        slug,
        title: extractTitle(content, slug),
        tags: extractTags(content),
        content,
      };
    } catch {
      return null;
    }
  }

  async search(query: string, limit = 5): Promise<KnowledgeSearchResult[]> {
    const files = await this.mdFiles();
    const results: KnowledgeSearchResult[] = [];
    const needle = query.toLowerCase();

    for (const file of files) {
      const content = await readFile(path.join(DOCS_DIR, file), "utf-8");
      const idx = content.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 60);
      const excerpt = content.slice(start, idx + needle.length + 60).trim();
      results.push({
        slug: slugFromFilename(file),
        title: extractTitle(content, slugFromFilename(file)),
        tags: extractTags(content),
        excerpt,
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  private async mdFiles(): Promise<string[]> {
    const entries = await readdir(DOCS_DIR);
    return entries.filter((f) => f.endsWith(".md"));
  }
}
