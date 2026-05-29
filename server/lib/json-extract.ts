/**
 * Shared JSON extractor for LLM output.
 *
 * Models wrap JSON in ```json fences```, prose, or get cut off mid-object by
 * max_tokens. This extracts the first plausible JSON object and repairs simple
 * truncation (unclosed braces/brackets) — the common failure mode with
 * reasoning models. Ported from the battle-tested copy in tasks/executor.ts so
 * new code (the agent tool-loop) reuses one implementation instead of adding
 * yet another bespoke parser.
 */
export function extractFirstJson<T = Record<string, unknown>>(content: string): T | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = (fenced?.[1] ?? content.match(/\{[\s\S]*\}/)?.[0] ?? content).trim();

  // Happy path
  try { return JSON.parse(str) as T; } catch { /* try repair */ }

  // Truncation repair: walk the string tracking string/escape state and brace
  // depth, then close any still-open braces/brackets.
  try {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const ch of str) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    if (depth > 0) {
      // Strip a trailing incomplete key/value (e.g. ,"key": or ,"key":"partial)
      const trimmed = str.replace(/,?\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, '');
      const repaired = trimmed + '}'.repeat(depth);
      return JSON.parse(repaired) as T;
    }
  } catch { /* fall through */ }

  return null;
}
