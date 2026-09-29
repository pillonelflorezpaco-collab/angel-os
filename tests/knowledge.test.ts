import { describe, it, expect } from "vitest";
import { MarkdownKnowledgeProvider, resolveSafeDocPath, UnsafeSlugError } from "../knowledge/markdown/index.js";

describe("knowledge document path safety", () => {
  const provider = new MarkdownKnowledgeProvider();

  it("rejects a slug that attempts to traverse to /etc/passwd", () => {
    expect(() => resolveSafeDocPath("../../etc/passwd")).toThrow(UnsafeSlugError);
  });

  it("rejects a deeper traversal attempt", () => {
    expect(() => resolveSafeDocPath("../../../secret")).toThrow(UnsafeSlugError);
  });

  it("rejects an absolute path", () => {
    expect(() => resolveSafeDocPath("/etc/passwd")).toThrow(UnsafeSlugError);
  });

  it("rejects a slug containing a path separator", () => {
    expect(() => resolveSafeDocPath("sub/dir")).toThrow(UnsafeSlugError);
  });

  it("rejects a slug with a null byte or other unsafe characters", () => {
    expect(() => resolveSafeDocPath("principles.md\0.txt")).toThrow(UnsafeSlugError);
  });

  it("accepts a normal valid slug", () => {
    expect(() => resolveSafeDocPath("principles")).not.toThrow();
    expect(() => resolveSafeDocPath("current-priorities")).not.toThrow();
  });

  it("readDocument returns null (not a thrown filesystem error) for a traversal attempt", async () => {
    const result = await provider.readDocument("../../../etc/passwd");
    expect(result).toBeNull();
  });

  it("readDocument still works for a real, safe document", async () => {
    const result = await provider.readDocument("principles");
    expect(result).not.toBeNull();
    expect(result?.slug).toBe("principles");
  });
});
