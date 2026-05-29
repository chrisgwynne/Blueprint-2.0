/**
 * Shared JSON extractor for LLM output.
 *
 * Models wrap JSON in ```json fences```, prose, or get cut off mid-object by
 * max_tokens. This extracts the first plausible JSON object and repairs simple
 * truncation (unterminated string + unclosed braces/brackets) — the common
 * failure mode with reasoning models. New code (the agent tool-loop) reuses one
 * implementation instead of adding yet another bespoke parser.
 */
export function extractFirstJson<T = Record<string, unknown>>(content: string): T | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = (fenced?.[1] ?? content.match(/\{[\s\S]*\}/)?.[0] ?? content).trim();

  // Happy path.
  try { return JSON.parse(str) as T; } catch { /* try repair */ }

  return repairTruncated<T>(str);
}

/**
 * Compute the suffix needed to close any open string and open brackets at the
 * end of `s` (e.g. `{"a":[1` → `]}`). Returns null if `s` ends mid-escape,
 * where closing can't be done safely.
 */
function closerFor(s: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (escaped) return null;
  let closer = inString ? '"' : '';
  for (let i = stack.length - 1; i >= 0; i--) {
    const c = stack[i];
    if (c) closer += c;
  }
  return closer;
}

/**
 * Repair a truncated JSON object: close the open string/brackets and parse.
 * If a dangling key/colon/comma trails the last complete value, shrink from the
 * end (bounded) until it parses. Handles the realistic max_tokens-cutoff cases:
 *   {"a":1,"b":{"c":2            → {"a":1,"b":{"c":2}}
 *   {"s":"partial text          → {"s":"partial text"}
 *   {"a":1,"b":                  → {"a":1}
 */
function repairTruncated<T>(str: string): T | null {
  let attempts = 0;
  for (let end = str.length; end > 0 && attempts < 1000; end--) {
    // Strip trailing whitespace / dangling comma; shrink past a dangling colon.
    const slice = str.slice(0, end).replace(/[\s,]+$/, '');
    if (slice.endsWith(':')) { end = slice.length; continue; }
    const closer = closerFor(slice);
    if (closer === null) continue;
    attempts++;
    try { return JSON.parse(slice + closer) as T; } catch { /* shrink and retry */ }
  }
  return null;
}
