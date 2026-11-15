// Strict JSON loading for anything that came from outside: packages, ledgers, configurations,
// trust stores, exchange files, key files.
//
// JSON.parse accepts things that are dangerous when the bytes are signed and other programs read
// them too:
//   - duplicate member names: {"outcome":"accept","outcome":"reject"}. JSON.parse (and Python, Go)
//     keep the last one; some parsers keep the first. Two verifiers could disagree about what a
//     validly signed file says. RFC 8259 §4 leaves it undefined; I-JSON (RFC 7493 §2.3) forbids it.
//   - lone UTF-16 surrogates ("\ud800"), which aren't Unicode text and which RFC 8785 canonical
//     JSON can't represent (I-JSON §2.1).
//   - unbounded nesting, which turns into deep recursion further on.
// parseJson refuses all three, so every program applying these rules reads one meaning or none.

/** No legitimate file in this format family nests anywhere near this deep. */
export const MAX_JSON_DEPTH = 64;

const LONE_SURROGATE = /\p{Surrogate}/u;

export class JsonError extends Error {}

/**
 * JSON.parse plus: duplicate member names, lone surrogates and nesting deeper than
 * MAX_JSON_DEPTH are errors. Member names are compared after unescaping, so "a" and "a"
 * are the same name.
 */
export function parseJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new JsonError(`not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  checkStructure(text);
  checkStrings(value);
  return value;
}

/**
 * One pass over text JSON.parse has already accepted. Tracks the open containers; for objects,
 * the names seen so far and whether the next string is a member name.
 */
function checkStructure(text: string): void {
  type Frame = { names: Set<string>; expectName: boolean } | null; // null = array
  const stack: Frame[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
      if (stack.length >= MAX_JSON_DEPTH) throw new JsonError(`JSON nests deeper than ${MAX_JSON_DEPTH} levels`);
      stack.push(c === 0x7b ? { names: new Set(), expectName: true } : null);
    } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
      stack.pop();
    } else if (c === 0x2c /* , */) {
      const top = stack.at(-1);
      if (top) top.expectName = true;
    } else if (c === 0x22 /* " */) {
      const start = i;
      for (i++; text.charCodeAt(i) !== 0x22; i++) if (text.charCodeAt(i) === 0x5c /* \ */) i++;
      const top = stack.at(-1);
      if (top?.expectName) {
        const name = JSON.parse(text.slice(start, i + 1)) as string;
        if (top.names.has(name)) throw new JsonError(`duplicate member name ${JSON.stringify(name)} at offset ${start}`);
        top.names.add(name);
        top.expectName = false;
      }
    }
  }
}

function checkStrings(v: unknown): void {
  if (typeof v === "string") {
    if (LONE_SURROGATE.test(v)) throw new JsonError("JSON string contains a lone UTF-16 surrogate");
  } else if (Array.isArray(v)) {
    for (const x of v) checkStrings(x);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (LONE_SURROGATE.test(k)) throw new JsonError("JSON member name contains a lone UTF-16 surrogate");
      checkStrings(x);
    }
  }
}
