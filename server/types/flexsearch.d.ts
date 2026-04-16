// ─── flexsearch shim ──────────────────────────────────────────────────────────
// flexsearch@0.7.43 ships no types and has no DefinitelyTyped entry.
// This covers the subset of the API used in Blueprint's kb-engine.js.

declare module 'flexsearch' {
  export interface IndexOptions {
    tokenize?: 'strict' | 'forward' | 'reverse' | 'full';
    resolution?: number;
    context?: boolean | { depth?: number; resolution?: number };
    cache?: boolean | number;
  }

  export class Index {
    constructor(options?: IndexOptions);
    add(id: number | string, content: string): void;
    append(id: number | string, content: string): void;
    update(id: number | string, content: string): void;
    remove(id: number | string): void;
    search(query: string, options?: number | { limit?: number; suggest?: boolean }): Array<number | string>;
    export(handler: (key: string, data: string) => void): void;
    import(key: string, data: string): void;
  }

  export class Document<T extends Record<string, unknown> = Record<string, unknown>> {
    constructor(options: {
      document: { id: string; index: string[] };
      tokenize?: string;
      resolution?: number;
      cache?: boolean | number;
    });
    add(document: T): void;
    update(document: T): void;
    remove(id: string | number): void;
    search(query: string, options?: { limit?: number; enrich?: boolean; index?: string[] }): Array<{
      field: string;
      result: Array<string | number | (T & { id: string })>;
    }>;
    export(handler: (key: string, data: string) => void): void;
    import(key: string, data: string): void;
  }

  export class Worker {
    constructor(options?: IndexOptions);
    addAsync(id: number | string, content: string): Promise<void>;
    searchAsync(query: string, options?: number | { limit?: number }): Promise<Array<number | string>>;
  }

  export default Index;
}
