/**
 * Custom syntax checker for Ritobin text format.
 *
 * Checks:
 *  - Bracket matching with indent-aware blame
 *  - Type name validation (25 valid types, case-insensitive)
 *  - Container type syntax: list[T], list2[T], option[T], map[K,V]
 *  - Entry/field structure: name: type = value
 *  - String literal syntax (unterminated strings)
 */

export interface SyntaxError {
  line: number;      // 1-based
  column: number;    // 1-based
  length: number;    // how many characters to underline
  message: string;
}

interface BracketEntry {
  char: string;
  line: number;
  column: number;
  indent: number;
}

const BRACKET_PAIRS: Record<string, string> = {
  '{': '}',
  '[': ']',
};

const CLOSING_TO_OPENING: Record<string, string> = {
  '}': '{',
  ']': '[',
};

// All 25 valid ritobin type names (matched case-insensitively)
const VALID_TYPES_LIST = [
  'none', 'bool', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64',
  'f32', 'vec2', 'vec3', 'vec4', 'mtx44', 'rgba', 'string', 'hash', 'file',
  'list', 'list2', 'pointer', 'embed', 'link', 'option', 'map', 'flag',
];
const VALID_TYPES = new Set(VALID_TYPES_LIST);

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Suggest the closest valid type name for a misspelled type.
 * Returns null if no close match is found (distance > 3).
 */
export function suggestType(input: string): string | null {
  const lower = input.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of VALID_TYPES_LIST) {
    const d = levenshtein(lower, t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 3 ? best : null;
}

// Container types that require [T] or [K,V] parameters
const CONTAINER_SINGLE = new Set(['list', 'list2', 'option']);
const CONTAINER_MAP = new Set(['map']);

function measureIndent(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') n++;
    else if (line[i] === '\t') n += 4;
    else break;
  }
  return n;
}

/** Check if a character is a valid word character in ritobin (matches Jade's read_word). */
function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_+\-.]/.test(c);
}

interface LineScan {
  contentParts: string;
  unterminatedString: boolean;
  unterminatedStringCol: number;
  unterminatedStringLen: number;
}

function scanLine(line: string, startI: number): LineScan {
  let content = '';
  let i = startI;
  let unterminated = false;
  let untermCol = 0;
  let untermLen = 0;

  while (i < line.length) {
    const ch = line[i];

    // Comment — rest of line is ignored
    if (ch === '#') break;

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const strStart = i;
      i++; // skip opening quote
      let closed = false;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { i++; closed = true; break; }
        i++;
      }
      if (!closed) {
        unterminated = true;
        untermCol = strStart;
        untermLen = i - strStart;
      }
      content += ' STRING ';
      continue;
    }

    content += ch;
    i++;
  }

  return { contentParts: content, unterminatedString: unterminated, unterminatedStringCol: untermCol, unterminatedStringLen: untermLen };
}

/**
 * Full syntax check — brackets + type/structure validation.
 */
export function checkSyntax(text: string): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = text.split('\n');

  // ── Pass 1: Bracket matching ──
  const bracketErrors = checkBrackets(text);
  errors.push(...bracketErrors);

  // ── Pass 2: Line-by-line content validation ──
  let braceDepth = 0;
  const blockStack: Array<'section' | 'struct' | 'container'> = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;
    let i = 0;

    // Skip leading whitespace
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

    // Empty line or comment-only line
    if (i >= line.length) continue;
    if (line[i] === '#') continue;

    // Scan for unterminated strings
    const scan = scanLine(line, i);
    if (scan.unterminatedString) {
      errors.push({
        line: lineNum,
        column: scan.unterminatedStringCol + 1,
        length: scan.unterminatedStringLen,
        message: 'Unterminated string',
      });
      updateBraceDepth(line, i);
      continue;
    }

    // Get trimmed content
    const trimmed = scan.contentParts.trim();

    // Skip lines that are just closing braces
    if (trimmed === '}' || trimmed === '{}') {
      if (trimmed === '}' && blockStack.length > 0) blockStack.pop();
      if (trimmed === '}') braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    // Detect and validate type annotations in "name: type = value" patterns
    const colonIdx = findColonInContent(line, i);
    if (colonIdx >= 0) {
      validateTypeAnnotation(line, lineNum, colonIdx, errors);
    }

    // Update brace depth for next line's context
    updateBraceDepth(line, i);
  }

  return errors;

  function updateBraceDepth(line: string, startI: number) {
    let ii = startI;
    while (ii < line.length) {
      const ch = line[ii];
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        const q = ch;
        ii++;
        while (ii < line.length) {
          if (line[ii] === '\\') { ii += 2; continue; }
          if (line[ii] === q) { ii++; break; }
          ii++;
        }
        continue;
      }
      if (ch === '{') {
        braceDepth++;
        const before = line.substring(startI, ii).trim().toLowerCase();
        if (/\b(list|list2|option)\s*\[/.test(before) || /\bmap\s*\[/.test(before)) {
          blockStack.push('container');
        } else if (braceDepth === 1) {
          blockStack.push('section');
        } else {
          blockStack.push('struct');
        }
      }
      if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        if (blockStack.length > 0) blockStack.pop();
      }
      ii++;
    }
  }
}

/**
 * Find the first colon in content (not inside strings or comments).
 */
function findColonInContent(line: string, startI: number): number {
  let i = startI;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') return -1;
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === ':') return i;
    if (ch === '=' || ch === '{' || ch === '}') return -1;
    i++;
  }
  return -1;
}

/**
 * Validate the type annotation after a colon in a "name: type = value" line.
 */
function validateTypeAnnotation(line: string, lineNum: number, colonIdx: number, errors: SyntaxError[]) {
  let i = colonIdx + 1;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] === '#') {
    errors.push({
      line: lineNum,
      column: colonIdx + 1,
      length: 1,
      message: 'Expected type name after ":"',
    });
    return;
  }

  // Read the type word
  const typeStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const typeWord = line.substring(typeStart, i);

  if (typeWord.length === 0) {
    errors.push({
      line: lineNum,
      column: typeStart + 1,
      length: 1,
      message: 'Expected type name after ":"',
    });
    return;
  }

  const typeLower = typeWord.toLowerCase();

  if (!VALID_TYPES.has(typeLower)) {
    errors.push({
      line: lineNum,
      column: typeStart + 1,
      length: typeWord.length,
      message: `Unknown type "${typeWord}"`,
    });
    return;
  }

  // Skip whitespace after type name
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  // Container types must have parameters
  if (CONTAINER_SINGLE.has(typeLower)) {
    if (i >= line.length || line[i] !== '[') {
      errors.push({
        line: lineNum,
        column: typeStart + 1,
        length: typeWord.length,
        message: `"${typeLower}" requires a type parameter, e.g. ${typeLower}[type]`,
      });
      return;
    }
    validateContainerSingleParam(line, lineNum, i, typeLower, errors);
    return;
  }

  if (CONTAINER_MAP.has(typeLower)) {
    if (i >= line.length || line[i] !== '[') {
      errors.push({
        line: lineNum,
        column: typeStart + 1,
        length: typeWord.length,
        message: '"map" requires type parameters, e.g. map[key,value]',
      });
      return;
    }
    validateMapParams(line, lineNum, i, errors);
    return;
  }

  // Non-container types should not have [...]
  if (i < line.length && line[i] === '[') {
    errors.push({
      line: lineNum,
      column: typeStart + 1,
      length: typeWord.length,
      message: `"${typeLower}" does not take type parameters`,
    });
    return;
  }
}

/**
 * Validate container[T] syntax — list[T], list2[T], option[T]
 */
function validateContainerSingleParam(line: string, lineNum: number, bracketIdx: number, typeName: string, errors: SyntaxError[]) {
  let i = bracketIdx + 1;

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  const innerStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const innerWord = line.substring(innerStart, i);

  if (innerWord.length === 0) {
    errors.push({
      line: lineNum,
      column: bracketIdx + 1,
      length: 1,
      message: `Expected type name inside ${typeName}[...]`,
    });
    return;
  }

  const innerLower = innerWord.toLowerCase();
  if (!VALID_TYPES.has(innerLower)) {
    errors.push({
      line: lineNum,
      column: innerStart + 1,
      length: innerWord.length,
      message: `Unknown type "${innerWord}" in ${typeName}[...]`,
    });
    return;
  }

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] !== ']') {
    errors.push({
      line: lineNum,
      column: i + 1,
      length: 1,
      message: `Expected "]" to close ${typeName}[${innerWord}`,
    });
    return;
  }
}

/**
 * Validate map[K,V] syntax.
 */
function validateMapParams(line: string, lineNum: number, bracketIdx: number, errors: SyntaxError[]) {
  let i = bracketIdx + 1;

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  // Read key type
  const keyStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const keyWord = line.substring(keyStart, i);

  if (keyWord.length === 0) {
    errors.push({
      line: lineNum,
      column: bracketIdx + 1,
      length: 1,
      message: 'Expected key type name inside map[...]',
    });
    return;
  }

  const keyLower = keyWord.toLowerCase();
  if (!VALID_TYPES.has(keyLower)) {
    errors.push({
      line: lineNum,
      column: keyStart + 1,
      length: keyWord.length,
      message: `Unknown key type "${keyWord}" in map[...]`,
    });
    return;
  }

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] !== ',') {
    errors.push({
      line: lineNum,
      column: i + 1,
      length: 1,
      message: 'Expected "," between key and value types in map[key,value]',
    });
    return;
  }
  i++;

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  // Read value type
  const valStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const valWord = line.substring(valStart, i);

  if (valWord.length === 0) {
    errors.push({
      line: lineNum,
      column: valStart + 1,
      length: 1,
      message: 'Expected value type name inside map[key,...]',
    });
    return;
  }

  const valLower = valWord.toLowerCase();
  if (!VALID_TYPES.has(valLower)) {
    errors.push({
      line: lineNum,
      column: valStart + 1,
      length: valWord.length,
      message: `Unknown value type "${valWord}" in map[...]`,
    });
    return;
  }

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] !== ']') {
    errors.push({
      line: lineNum,
      column: i + 1,
      length: 1,
      message: `Expected "]" to close map[${keyWord},${valWord}`,
    });
    return;
  }
}

/**
 * Check bracket matching in ritobin text content.
 * Skips brackets inside strings (double/single-quoted) and comments (#).
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

    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

    if (line[i] === '#') continue;

    while (i < line.length) {
      const ch = line[i];

      if (ch === '#') break;

      if (ch === '"') {
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === '"') { i++; break; }
          i++;
        }
        continue;
      }

      if (ch === "'") {
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === "'") { i++; break; }
          i++;
        }
        continue;
      }

      if (ch === '{' || ch === '[') {
        stack.push({ char: ch, line: lineNum, column: i + 1, indent: lineIndent });
        i++;
        continue;
      }

      if (ch === '}' || ch === ']') {
        const expectedOpener = CLOSING_TO_OPENING[ch];

        if (stack.length === 0) {
          errors.push({
            line: lineNum,
            column: i + 1,
            length: 1,
            message: `Unexpected '${ch}' — no matching '${expectedOpener}'`,
          });
          i++;
          continue;
        }

        const top = stack[stack.length - 1];
        const isSameLine = top.line === lineNum;
        const isStructural = (i === lineIndent);

        // ── Case 1: Inline pair (opener on same line) ──
        if (isSameLine && top.char === expectedOpener) {
          stack.pop();
          i++;
          continue;
        }

        // ── Case 2: Structural closer (first char on its line) ──
        if (isStructural) {
          if (top.char === expectedOpener && top.indent === lineIndent) {
            stack.pop();
            i++;
            continue;
          }

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
                length: 1,
                message: `Unclosed '${bad.char}' — no matching '${BRACKET_PAIRS[bad.char]}'`,
              });
            }
            stack.splice(matchIdx);
            i++;
            continue;
          }

          if (top.char === expectedOpener) {
            stack.pop();
            i++;
            continue;
          }

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
                length: 1,
                message: `Unclosed '${bad.char}' — no matching '${BRACKET_PAIRS[bad.char]}'`,
              });
            }
            stack.splice(matchIdx);
            i++;
            continue;
          }

          errors.push({
            line: lineNum,
            column: i + 1,
            length: 1,
            message: `Mismatched '${ch}' — expected '${BRACKET_PAIRS[top.char]}' to close '${top.char}' opened at line ${top.line}`,
          });
          stack.pop();
          i++;
          continue;
        }

        // ── Case 3: Non-structural, non-same-line closer ──
        errors.push({
          line: lineNum,
          column: i + 1,
          length: 1,
          message: `Extra '${ch}' — a block-closing bracket should be on its own line`,
        });
        i++;
        continue;
      }

      i++;
    }
  }

  for (const entry of stack) {
    errors.push({
      line: entry.line,
      column: entry.column,
      length: 1,
      message: `Unclosed '${entry.char}' — expected '${BRACKET_PAIRS[entry.char]}'`,
    });
  }

  return errors;
}
