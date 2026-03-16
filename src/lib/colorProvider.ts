/**
 * Color Provider for Ritobin Monaco Editor
 *
 * Provides inline color swatches and a color picker for `constantValue: vec4`
 * lines that live inside `birthColor` or `*Color: embed` blocks.
 *
 * The vec4 values are treated as RGBA in the 0-1 range.
 *
 * Uses a single top-down pass with a block stack (O(n)) instead of
 * per-line backwards walks (O(n²)) so large files stay fast.
 * Registration is deferred so the editor renders content first.
 */

import type { Monaco } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { RITOBIN_LANGUAGE_ID } from './ritobinLanguage';

/** Regex to match a vec4 constant value assignment, capturing the four numbers */
const VEC4_CONST_RE =
  /vec4\s*=\s*\{\s*(-?[\d.]+f?)\s*,\s*(-?[\d.]+f?)\s*,\s*(-?[\d.]+f?)\s*,\s*(-?[\d.]+f?)\s*\}/;

/** Regex to match a bare vec4 value inside a list: { r, g, b, a } */
const BARE_VEC4_RE =
  /^\s*\{\s*(-?[\d.]+f?)\s*,\s*(-?[\d.]+f?)\s*,\s*(-?[\d.]+f?)\s*,\s*(-?[\d.]+f?)\s*\}\s*$/;

const COLOR_HEADER_RE = /\bcolor\s*:\s*embed\b/i;
const VALUES_LIST_RE = /values\s*:\s*list\s*\[\s*vec4\s*\]/i;

/**
 * Parse a float string that may end with 'f' (e.g. "0.5f" → 0.5).
 */
function parseFloat_(s: string): number {
  return parseFloat(s.replace(/f$/, ''));
}

/**
 * Clamp a value to 0–1.
 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Single-pass O(n) scan that tracks block context with a stack.
 *
 * Block types on the stack:
 *   'color'  — inside a `*color: embed = ValueColor {` block
 *   'values' — inside a `values: list[vec4] = {` that is inside a color block
 *   'other'  — any other block
 *
 * Lines where `{` and `}` are balanced (opens === closes) are treated as
 * inline values (potential vec4), not block boundaries.
 */
function scanColors(model: MonacoType.editor.ITextModel): MonacoType.languages.IColorInformation[] {
  const colors: MonacoType.languages.IColorInformation[] = [];
  const lineCount = model.getLineCount();
  const stack: ('color' | 'values' | 'other')[] = [];

  for (let i = 1; i <= lineCount; i++) {
    const line = model.getLineContent(i);

    // Count braces
    let opens = 0;
    let closes = 0;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '{') opens++;
      else if (line[c] === '}') closes++;
    }

    if (opens === 0 && closes === 0) continue;

    if (opens === closes) {
      // Balanced braces — inline value, check for vec4 color
      let m: RegExpExecArray | null = null;

      if (line.includes('constantValue') && line.includes('vec4')) {
        m = VEC4_CONST_RE.exec(line);
        if (m && !stack.includes('color')) m = null;
      }

      if (!m) {
        m = BARE_VEC4_RE.exec(line);
        if (m && stack[stack.length - 1] !== 'values') m = null;
      }

      if (!m) continue;

      const r = clamp01(parseFloat_(m[1]));
      const g = clamp01(parseFloat_(m[2]));
      const b = clamp01(parseFloat_(m[3]));
      const a = clamp01(parseFloat_(m[4]));

      const braceOpen = line.indexOf('{');
      const braceClose = line.indexOf('}', braceOpen);
      if (braceOpen === -1 || braceClose === -1) continue;

      colors.push({
        color: { red: r, green: g, blue: b, alpha: a },
        range: {
          startLineNumber: i,
          startColumn: braceOpen + 1,
          endLineNumber: i,
          endColumn: braceClose + 2,
        },
      });
    } else {
      // Unbalanced — process closes (pop), then opens (push)
      for (let c = 0; c < closes; c++) {
        if (stack.length > 0) stack.pop();
      }

      for (let c = 0; c < opens; c++) {
        let type: 'color' | 'values' | 'other' = 'other';
        if (COLOR_HEADER_RE.test(line)) {
          type = 'color';
        } else if (VALUES_LIST_RE.test(line) && stack.includes('color')) {
          type = 'values';
        }
        stack.push(type);
      }
    }
  }

  return colors;
}

/**
 * Register the color provider with deferred activation.
 *
 * An empty provider is registered first so Monaco doesn't block the initial
 * editor render. After a short delay the real provider replaces it.
 */
export function registerColorProvider(monaco: Monaco): MonacoType.IDisposable {
  const realProvider: MonacoType.languages.DocumentColorProvider = {
    provideDocumentColors(model: MonacoType.editor.ITextModel) {
      return scanColors(model);
    },

    provideColorPresentations(
      _model: MonacoType.editor.ITextModel,
      colorInfo: MonacoType.languages.IColorInformation,
    ) {
      const { red, green, blue, alpha } = colorInfo.color;

      const fmt = (v: number) => {
        const s = v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
        return s === '' ? '0' : s;
      };

      const label = `{ ${fmt(red)}, ${fmt(green)}, ${fmt(blue)}, ${fmt(alpha)} }`;

      return [
        {
          label,
          textEdit: {
            range: colorInfo.range,
            text: label,
          },
        },
      ];
    },
  };

  // Start with an empty provider so the editor renders content first
  let disposable = monaco.languages.registerColorProvider(RITOBIN_LANGUAGE_ID, {
    provideDocumentColors() { return []; },
    provideColorPresentations() { return []; },
  });

  // Swap in the real provider after the editor has painted
  const timeout = setTimeout(() => {
    disposable.dispose();
    disposable = monaco.languages.registerColorProvider(RITOBIN_LANGUAGE_ID, realProvider);
  }, 150);

  return {
    dispose() {
      clearTimeout(timeout);
      disposable.dispose();
    },
  };
}
