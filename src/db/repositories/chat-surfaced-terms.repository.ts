import { asc, eq } from "drizzle-orm";
import type { Executor } from "../client";
import { chatSurfacedTerms, type ChatSurfacedTerm } from "../schema";
import { BaseRepository } from "./base.repository";

export type SurfacedTermDraft = { term: string; firstSeq: number };

/** Dedup key: case, edge whitespace and runs of whitespace do not make a new term. */
export function normalizeTerm(term: string): string {
  return term.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export class ChatSurfacedTermsRepository extends BaseRepository<
  typeof chatSurfacedTerms
> {
  constructor(db: Executor) {
    super(db, chatSurfacedTerms);
  }

  list(chatId: string): Promise<ChatSurfacedTerm[]> {
    return this.findMany({
      where: eq(chatSurfacedTerms.chatId, chatId),
      orderBy: asc(chatSurfacedTerms.firstSeq),
    });
  }

  /** The drafts this chat has not surfaced yet, deduplicated among themselves. */
  async unseen(chatId: string, drafts: SurfacedTermDraft[]): Promise<SurfacedTermDraft[]> {
    const known = new Set((await this.list(chatId)).map((row) => row.termNorm));
    const fresh = new Map<string, SurfacedTermDraft>();
    for (const draft of drafts) {
      const norm = normalizeTerm(draft.term);
      if (!norm || known.has(norm) || fresh.has(norm)) continue;
      fresh.set(norm, draft);
    }
    return [...fresh.values()];
  }

  /** Records terms; returns only the ones that were new to this chat. */
  async addMany(chatId: string, drafts: SurfacedTermDraft[]): Promise<ChatSurfacedTerm[]> {
    const byNorm = new Map<string, SurfacedTermDraft>();
    for (const draft of drafts) {
      const norm = normalizeTerm(draft.term);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, draft);
    }
    return this.insertIgnore(
      [...byNorm].map(([termNorm, draft]) => ({
        chatId,
        termNorm,
        term: draft.term.trim(),
        firstSeq: draft.firstSeq,
      })),
      [chatSurfacedTerms.chatId, chatSurfacedTerms.termNorm],
    );
  }
}
