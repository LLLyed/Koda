import type { ToolDefinition } from "./coreTools";

export interface RetrievalResult {
  tool: ToolDefinition;
  score: number;
}

interface IndexedDoc {
  tool: ToolDefinition;
  weights: Map<string, number>;
  norm: number;
}

/**
 * 轻量级分词：
 * - 英文/数字/下划线标识符按词切分，并额外拆分下划线（read_file -> read_file, read, file）
 * - 中文按连续汉字切分为二元组（bigram），单字运行保留单字
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /([a-z0-9]+(?:_[a-z0-9]+)*)|([\u4e00-\u9fff]+)/g;

  for (const match of text.toLowerCase().matchAll(pattern)) {
    const identifier = match[1];
    const cjkRun = match[2];

    if (identifier) {
      tokens.push(identifier);
      const parts = identifier.split("_");
      if (parts.length > 1) tokens.push(...parts);
    } else if (cjkRun) {
      if (cjkRun.length === 1) {
        tokens.push(cjkRun);
      } else {
        for (let index = 0; index < cjkRun.length - 1; index += 1) {
          tokens.push(cjkRun.slice(index, index + 2));
        }
      }
    }
  }

  return tokens;
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * TF-IDF + 余弦相似度检索引擎：
 * 启动时为所有扩展工具的 name + description 建立倒排权重索引。
 */
export class ToolRetriever {
  private readonly docs: IndexedDoc[] = [];
  private readonly idf = new Map<string, number>();

  constructor(tools: ToolDefinition[]) {
    this.buildIndex(tools);
  }

  search(query: string, topK = 3): RetrievalResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.docs.length === 0) return [];

    const counts = termCounts(queryTokens);
    const queryWeights = new Map<string, number>();
    let querySumSquares = 0;

    for (const [term, count] of counts) {
      const idf = this.idf.get(term);
      if (idf === undefined) continue;
      const weight = (count / queryTokens.length) * idf;
      queryWeights.set(term, weight);
      querySumSquares += weight * weight;
    }

    const queryNorm = Math.sqrt(querySumSquares);
    if (queryNorm === 0) return [];

    return this.docs
      .map((doc) => {
        let dot = 0;
        for (const [term, queryWeight] of queryWeights) {
          const docWeight = doc.weights.get(term);
          if (docWeight !== undefined) dot += queryWeight * docWeight;
        }
        const score = doc.norm === 0 ? 0 : dot / (queryNorm * doc.norm);
        return { tool: doc.tool, score };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private buildIndex(tools: ToolDefinition[]): void {
    const tokenized = tools.map((tool) => ({
      tool,
      tokens: tokenize(`${tool.name} ${tool.description}`),
    }));

    const docFreq = new Map<string, number>();
    for (const doc of tokenized) {
      for (const term of new Set(doc.tokens)) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }

    const totalDocs = tokenized.length;
    for (const [term, freq] of docFreq) {
      this.idf.set(term, Math.log((totalDocs + 1) / (freq + 1)) + 1);
    }

    for (const doc of tokenized) {
      if (doc.tokens.length === 0) {
        this.docs.push({ tool: doc.tool, weights: new Map(), norm: 0 });
        continue;
      }

      const weights = new Map<string, number>();
      let sumSquares = 0;
      for (const [term, count] of termCounts(doc.tokens)) {
        const idf = this.idf.get(term) ?? 0;
        const weight = (count / doc.tokens.length) * idf;
        if (weight <= 0) continue;
        weights.set(term, weight);
        sumSquares += weight * weight;
      }

      this.docs.push({ tool: doc.tool, weights, norm: Math.sqrt(sumSquares) });
    }
  }
}
