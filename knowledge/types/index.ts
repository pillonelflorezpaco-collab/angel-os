export interface KnowledgeDocumentSummary {
  slug: string;
  title: string;
  tags: string[];
}

export interface KnowledgeDocumentContent extends KnowledgeDocumentSummary {
  content: string;
}

export interface KnowledgeSearchResult extends KnowledgeDocumentSummary {
  excerpt: string;
}

export interface KnowledgeProvider {
  listDocuments(): Promise<KnowledgeDocumentSummary[]>;
  readDocument(slug: string): Promise<KnowledgeDocumentContent | null>;
  search(query: string, limit?: number): Promise<KnowledgeSearchResult[]>;
}
