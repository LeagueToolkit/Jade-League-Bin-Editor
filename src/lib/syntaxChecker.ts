/**
 * Custom syntax checker for Ritobin text format.
 *
 * Phase 1: Bracket matching — checks that all { } [ ] are properly
 * paired and nested, while ignoring brackets inside strings and comments.
 *
 * Uses indentation heuristics to blame the *extra* bracket rather than
 * the far-away closer, avoiding the "error at end of file" problem.
 *
 * Key insight: in valid ritobin, a closing bracket is either:
 *   (a) "structural" — first non-WS char on its line, closing a block
 *       whose opener is on a DIFFERENT line at the SAME indent, or
 *   (b) "inline" — its matching opener is on the SAME line
 *       (e.g.  vec3 = { 1.0, 2.0, 3.0 }  or  embed = Foo {})
 *
 * A closer that is neither structural NOR has a same-line opener is
 * almost certainly an accidental extra bracket.
 */

export interface SyntaxError {
  line: number;      // 1-based
  column: number;    // 1-based
  message: string;
}

interface BracketEntry {
  char: string;
  line: number;
  column: number;
  indent: number;    // leading whitespace count of the line this bracket is on
}

const BRACKET_PAIRS: Record<string, string> = {
  '{': '}',
  '[': ']',
};

const CLOSING_TO_OPENING: Record<string, string> = {
  '}': '{',
  ']': '[',
};

/** Count leading spaces/tabs (tab = 4 spaces to match ritobin convention). */
function measureIndent(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') n++;
    else if (line[i] === '\t') n += 4;
    else break;
  }
  return n;
}

/**
 * Check bracket matching in ritobin text content.
 * Skips brackets inside strings (double/single-quoted) and comments (# or //).
 */
export function checkBrackets(text: string): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const stack: BracketEntry[] = [];
  const lines = text.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;
    const lineIndent = measureIndent(line);
    let i = 0;

    // Skip leading whitespace
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

    // Skip comment lines (# or //)
    if (line[i] === '#') continue;
    if (line[i] === '/' && i + 1 < line.length && line[i + 1] === '/') continue;

    // Scan the line character by character
    while (i < line.length) {
      const ch = line[i];

      // Skip inline comments
      if (ch === '#') break;

      // Skip double-quoted strings
      if (ch === '"') {
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === '"') { i++; break; }
          i++;
        }
        continue;
      }

      // Skip single-quoted strings
      if (ch === "'") {
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === "'") { i++; break; }
          i++;
        }
        continue;
      }

      // Opening brackets
      if (ch === '{' || ch === '[') {
        stack.push({ char: ch, line: lineNum, column: i + 1, indent: lineIndent });
        i++;
        continue;
      }

      // Closing brackets
      if (ch === '}' || ch === ']') {
        const expectedOpener = CLOSING_TO_OPENING[ch];

        if (stack.length === 0) {
          errors.push({
            line: lineNum,
            column: i + 1,
            message: `Unexpected '${ch}' — no matching '${expectedOpener}'`,
          });
          i++;
          continue;
        }

        const top = stack[stack.length - 1];
        // Is the top opener on the same line? (inline pair)
        const isSameLine = top.line === lineNum;
        // Is this closer the first non-WS character on the line? (structural)
        const isStructural = (i === lineIndent);

        // ── Case 1: Inline pair (opener on same line) ──
        // e.g. vec3 = { 1.0, 2.0 }  or  embed = Foo {}
        if (isSameLine && top.char === expectedOpener) {
          stack.pop();
          i++;
          continue;
        }

        // ── Case 2: Structural closer (first char on its line) ──
        if (isStructural) {
          // Perfect match: type and indent agree
          if (top.char === expectedOpener && top.indent === lineIndent) {
            stack.pop();
            i++;
            continue;
          }

          // Indent or type disagrees — scan stack for an opener
          // with matching type AND indent.  Flag everything above it.
          let matchIdx = -1;
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].char === expectedOpener && stack[s].indent === lineIndent) {
              matchIdx = s;
              break;
            }
          }

          if (matchIdx >= 0) {
            for (let s = stack.length - 1; s > matchIdx; s--) {
              const bad = stack[s];
              errors.push({
                line: bad.line,
                column: bad.column,
                message: `Unclosed '${bad.char}' — no matching '${BRACKET_PAIRS[bad.char]}'`,
              });
            }
            stack.splice(matchIdx);
            i++;
            continue;
          }

          // No indent match — fall back to type-only match
          if (top.char === expectedOpener) {
            stack.pop();
            i++;
            continue;
          }

          // Type mismatch — scan for any type match deeper
          matchIdx = -1;
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].char === expectedOpener) {
              matchIdx = s;
              break;
            }
          }
          if (matchIdx >= 0) {
            for (let s = stack.length - 1; s > matchIdx; s--) {
              const bad = stack[s];
              errors.push({
                line: bad.line,
                column: bad.column,
                message: `Unclosed '${bad.char}' — no matching '${BRACKET_PAIRS[bad.char]}'`,
              });
            }
            stack.splice(matchIdx);
            i++;
            continue;
          }

          // Nothing matches at all
          errors.push({
            line: lineNum,
            column: i + 1,
            message: `Mismatched '${ch}' — expected '${BRACKET_PAIRS[top.char]}' to close '${top.char}' opened at line ${top.line}`,
          });
          stack.pop();
          i++;
          continue;
        }

        // ── Case 3: Non-structural, non-same-line closer ──
        // In valid ritobin this shouldn't happen — a } that isn't the
        // first char on the line should only close something opened on
        // the SAME line.  Flag this bracket as the extra one.
        errors.push({
          line: lineNum,
          column: i + 1,
          message: `Extra '${ch}' — a block-closing bracket should be on its own line`,
        });
        // Do NOT pop the stack — this closer is the mistake, not the opener
        i++;
        continue;
      }

      i++;
    }
  }

  // Report any unclosed brackets remaining on the stack
  for (const entry of stack) {
    errors.push({
      line: entry.line,
      column: entry.column,
      message: `Unclosed '${entry.char}' — expected '${BRACKET_PAIRS[entry.char]}'`,
    });
  }

  return errors;
}
