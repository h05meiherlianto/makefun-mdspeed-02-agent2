// Fast Markdown renderer: parse(markdown) returns exactly the HTML that
// marked 18.1.3 renders with its default options (GFM on, breaks off,
// pedantic off, async off). Written from scratch against the CommonMark
// 0.31.2 and GFM 0.29 specifications; the observable output rules were
// checked against the reference implementation in the competition kit.
//
// The parser is a single-pass design: a line-based block parser that
// renders HTML strings directly (no token tree), plus a scanner-based
// inline parser with a delimiter stack for emphasis. It is dependency-free.

const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;
const ALNUM_RE = /[\p{L}\p{N}]/u;
// ASCII punctuation (the set a backslash can escape).
const ASCII_PUNCT = new Set(
  [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],
);

/** True when `ch` (one Unicode character) is ASCII punctuation. */
function isAsciiPunct(ch) {
  return ch.length === 1 && ASCII_PUNCT.has(ch);
}

/** True when `ch` (one Unicode character, or '') is punctuation. */
function isPunct(ch) {
  return ch !== '' && PUNCT_RE.test(ch);
}

/** True when `ch` is Unicode whitespace ('' counts as whitespace). */
function isWs(ch) {
  return ch === '' || WS_RE.test(ch);
}

/** True when `ch` is a Unicode letter or number. */
function isAlnum(ch) {
  return ch !== '' && ALNUM_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Escaping and URL handling
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP_RE =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Decode one numeric character reference body to its replacement text. */
function decodeNumeric(dec, hex) {
  const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  if (cp === 38) return '&amp;';
  return String.fromCodePoint(cp);
}

/**
 * Escape text for HTML output, decoding numeric character references the
 * way the reference does: a numeric reference becomes its character
 * (invalid ones become U+FFFD, 38 becomes "&amp;"), a bare "&" becomes
 * "&amp;" unless it starts something that looks like a reference
 * ("&#...;", "&#x...;" or "&word;"), and < > " ' are always escaped.
 * This is the escaping used for plain text and attribute values.
 */
const NEEDS_ESC_RE = /[&<>"']/;
function escText(s) {
  // Fast path: plain text with no escapable character passes through.
  if (!NEEDS_ESC_RE.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const m = NUM_REF_RE.exec(s.slice(i, i + 12));
      if (m && m.index === 0) {
        const dec = decodeNumeric(m[1], m[2]);
        out += ESCAPE_MAP[dec] !== undefined ? ESCAPE_MAP[dec] : dec;
        i += m[0].length;
        continue;
      }
      // Leave "&word;", "&#...;" and "&#x...;" alone; escape other "&".
      const rest = s.slice(i + 1);
      const ok = /^(?:#\d{1,7};|#[Xx][A-Fa-f0-9]{1,6};|\w+;)/.test(rest);
      out += ok ? '&' : '&amp;';
      i++;
      continue;
    }
    const e = ESCAPE_MAP[c];
    out += e !== undefined ? e : c;
    i++;
  }
  return out;
}

/** Escape text with every one of & < > " ' encoded (code spans, autolinks). */
function escAll(s) {
  if (!NEEDS_ESC_RE.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const e = ESCAPE_MAP[s[i]];
    out += e !== undefined ? e : s[i];
  }
  return out;
}

/**
 * Decode numeric character references in a string and turn a bare "&"
 * into "&amp;", leaving named-looking references alone. Used for link
 * text that is rendered as plain text (image alt text).
 */
function decodeRefs(s) {
  if (!NUM_REF_RE.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    return decodeNumeric(dec, hex);
  });
}

/** Remove a backslash before an ASCII punctuation character. */
function unescapePunct(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** The reference's URL cleaning: encodeURI, then un-escape "%25" to "%". */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Normalize a link label: trim, collapse whitespace runs to one space. */
function normalizeLabel(label) {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Node types (numbers, for compactness):
// 0 text (raw), 1 escaped char, 2 code span, 3 raw html, 4 hard break,
// 5 delimiter run, 6 link/image, 7 em, 8 strong
const AUTOLINK_RE =
  /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![-_]))>/;
const EMAIL_LOCAL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
// Structural inline characters (bulk text scan stops at these).
const SPECIAL_RE = /[\n\\`\[!<~*_]/g;
const SCHEME_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;
const MAILTO_RE = /^(?:mailto|xmpp):/;
const URL_RE =
  /^(?:(?:mailto|xmpp):[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[A-Za-z0-9-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-]))/;
const BACKPEDAL_RE =
  /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const TAG_OPEN_RE =
  /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/;
const TAG_CLOSE_RE = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/;
const TAG_COMMENT_RE = /^<!--(?:-?>|[\s\S]*?-->)/;
const TAG_PI_RE = /^<\?[\s\S]*?\?>/;
const TAG_DECL_RE = /^<![A-Za-z][\s\S]*?>/;
const TAG_CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;

/** Find the next backtick run of exactly `len` at or after `from`. */
function findCodeClose(src, from, len) {
  const n = src.length;
  let j = from;
  while (j < n) {
    if (src[j] === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      if (k - j === len) return j;
      j = k;
    } else {
      j++;
    }
  }
  return -1;
}

/**
 * Scan a link label starting at `i` (src[i] === '['). Returns
 * { label, end } (end is just past the closing ']') or null. Brackets
 * nest; backslash escapes and code spans are skipped; a label may not
 * contain a blank line.
 */
function scanLabel(src, i) {
  const n = src.length;
  let depth = 1;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      const run = k - j;
      // Marked's label regex: a run of 2+ backticks directly before the
      // closing bracket is label content; otherwise the run must open a
      // backtick string whose closing run (any length) follows. A single
      // backtick before ']' is not content, so the string swallows the
      // bracket and the label fails.
      if (run >= 2 && src[k] === ']') {
        j = k;
        continue;
      }
      let close = -1;
      let m = k;
      while (m < n) {
        if (src[m] === '`') {
          close = m;
          break;
        }
        m++;
      }
      if (close < 0) return null;
      let e2 = close;
      while (e2 < n && src[e2] === '`') e2++;
      j = e2;
      continue;
    }
    if (c === '[') {
      depth++;
      j++;
      continue;
    }
    if (c === ']') {
      depth--;
      if (depth === 0) return { label: src.slice(i + 1, j), end: j + 1 };
      j++;
      continue;
    }
    if (c === '\n') {
      let k = j + 1;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (src[k] === '\n' || k >= n) return null;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

/** Scan a link reference definition's label (no nested brackets). */
function scanDefLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  if (src[j] === ']' || (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) {
    // A whitespace-only label is rejected by the caller via trim check;
    // still scan so the caller can decide.
  }
  while (j < n) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') return { label: src.slice(i + 1, j), end: j + 1 };
    if (c === '\n') {
      let k = j + 1;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (src[k] === '\n' || k >= n) return null;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

/** Skip spaces, tabs and newlines from `i`. */
function skipWs(src, i) {
  while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n') i++;
  return i;
}

/**
 * Parse an inline link's "(dest title)" starting at `i` (src[i] === '(').
 * Returns { href, title, end } or null.
 */
function parseInlineLink(src, i) {
  const n = src.length;
  let j = skipWs(src, i + 1);
  let dest = '';
  if (src[j] === '<') {
    let k = j + 1;
    while (k < n && src[k] !== '>' && src[k] !== '\n' && src[k] !== '<') {
      if (src[k] === '\\') k++;
      k++;
    }
    if (k >= n || src[k] !== '>') return null;
    dest = src.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < n) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      if (c === '(') {
        depth++;
        j++;
      } else if (c === ')') {
        if (depth === 0) break;
        depth--;
        j++;
      } else if (c === '\\') {
        j += j + 1 < n && isAsciiPunct(src[j + 1]) ? 2 : 1;
      } else {
        j++;
      }
    }
    if (depth > 0) return null;
    dest = src.slice(start, j);
  }
  j = skipWs(src, j);
  let title = null;
  if (src[j] === '"' || src[j] === "'" || src[j] === '(') {
    const q = src[j];
    const close = q === '(' ? ')' : q;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === close) {
        ok = true;
        break;
      }
      if (q === '(' && c === '(') return null;
      k++;
    }
    if (!ok) return null;
    title = src.slice(j + 1, k);
    j = k + 1;
    j = skipWs(src, j);
  }
  if (src[j] !== ')') return null;
  return { href: unescapePunct(dest), title: title === null ? null : unescapePunct(title), end: j + 1 };
}

/** Does any node in `nodes` (at any depth) contain a link node? */
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 6) {
      if (nd.del) {
        if (containsLink(nd.kids)) return true;
      } else if (!nd.img && !nd.autolink) {
        // A plain link inside link text blocks the outer link; an
        // autolink does not.
        return true;
      } else if (nd.kids && containsLink(nd.kids)) {
        return true;
      }
    } else if ((nd.t === 7 || nd.t === 8) && containsLink(nd.kids)) {
      return true;
    }
  }
  return false;
}

/**
 * Try to parse a link or image starting at `i` (src[i] === '[' or '![').
 * Returns { node, end } or null.
 */
function tryLink(src, i, refs) {
  const n = src.length;
  let img = false;
  let start = i;
  if (src[i] === '!') {
    img = true;
    start = i + 1;
    if (src[start] !== '[') return null;
  }
  const lab = scanLabel(src, start);
  if (!lab) return null;
  // A tag or autolink inside the label that runs past the label's end
  // rejects the link entirely.
  if (labelTagBeyond(src, start + 1, lab.label)) return null;
  const end = lab.end;
  let href = null;
  let title = null;
  let after = end;
  if (src[end] === '(') {
    const pl = parseInlineLink(src, end);
    if (pl) {
      href = pl.href;
      title = pl.title;
      after = pl.end;
    }
  }
  if (href === null) {
    // Reference link (full, collapsed, or shortcut). An inline link
    // that failed to parse falls back to a shortcut reference, but a
    // full/collapsed reference whose label is undefined does not: the
    // reflink regex matched, so the shortcut is never tried and only
    // the '[' is consumed as text.
    if (lab.label.trim() === '') return null;
    let reflinkMatched = false;
    if (src[end] === '[') {
      const closeIdx = src.indexOf(']', end + 1);
      if (closeIdx >= 0) {
        const second = src.slice(end + 1, closeIdx);
        let refOk = second.length >= 1 && second.length <= 999 && second.trim() !== '';
        if (refOk) {
          for (let q = 0; q < second.length; q++) {
            if (second[q] === '\\') { q++; continue; }
            if (second[q] === '[') { refOk = false; break; }
          }
        }
        if (refOk) {
          reflinkMatched = true;
          const key = second === '' ? normalizeLabel(lab.label) : normalizeLabel(second);
          const def = refs.get(key);
          if (!def) return null;
          href = def.href;
          title = def.title;
          after = closeIdx + 1;
        }
      }
    }
    if (href === null && !reflinkMatched) {
      const def = refs.get(normalizeLabel(lab.label));
      if (!def) return null;
      href = def.href;
      title = def.title;
      after = end;
      // A collapsed reference "[foo][]" consumes the trailing "[]".
      if (src[end] === '[' && src[end + 1] === ']') after = end + 2;
    }
  }
  const kids = inlineNodes(lab.label, refs, true);
  processEmphasis(kids);
  if (!img && containsLink(kids)) return null;
  return {
    node: { t: 6, href, title, kids, img, autolink: false, text: null },
    end: after,
  };
}

/** Length of an inline tag or autolink match at `i` in `src`, or 0. */
function tagOrAutolinkLen(src, i) {
  const rest = src.slice(i);
  let m = TAG_COMMENT_RE.exec(rest) || TAG_PI_RE.exec(rest) || TAG_DECL_RE.exec(rest) || TAG_CDATA_RE.exec(rest);
  if (m) return m[0].length;
  m = TAG_OPEN_RE.exec(rest) || TAG_CLOSE_RE.exec(rest);
  if (m) return m[0].length;
  m = AUTOLINK_RE.exec(rest);
  if (m) return m[0].length;
  return 0;
}

/**
 * Marked's link-text check (Be): if the label contains a '<' that starts
 * a tag or autolink extending past the label's end, the link is rejected.
 * `labelStart` is the source offset of the label's first character.
 */
function labelTagBeyond(src, labelStart, label) {
  if (!label.includes('<')) return false;
  let s = 0;
  while (s < label.length) {
    const c = label[s];
    if (c === '\\') {
      s += 2;
      continue;
    }
    if (c === '`') {
      let k = s;
      while (k < label.length && label[k] === '`') k++;
      const run = k - s;
      const close = findCodeClose(label, k, run);
      if (close >= 0) {
        let m = close;
        while (m < label.length && label[m] === '`') m++;
        s = m;
        continue;
      }
      s = k;
      continue;
    }
    if (c !== '<') {
      s++;
      continue;
    }
    const len = tagOrAutolinkLen(src, labelStart + s);
    if (len > 0) {
      if (len > label.length - s) return true;
      s += len;
      continue;
    }
    s++;
  }
  return false;
}

/** Try a <...> autolink or inline HTML tag at `i` (src[i] === '<'). */
function tryAngle(src, i) {
  const rest = src.slice(i);
  let m = AUTOLINK_RE.exec(rest);
  if (m) {
    const inner = m[1];
    const at = inner.indexOf('@');
    const isEmail = at > 0 && inner.indexOf(':') < 0;
    const href = isEmail ? 'mailto:' + inner : inner;
    return {
      node: { t: 6, href, title: null, kids: null, img: false, autolink: true, text: inner },
      end: i + m[0].length,
    };
  }
  m = TAG_COMMENT_RE.exec(rest) || TAG_PI_RE.exec(rest) || TAG_DECL_RE.exec(rest) || TAG_CDATA_RE.exec(rest);
  if (m) return { node: { t: 3, s: m[0] }, end: i + m[0].length };
  m = TAG_OPEN_RE.exec(rest) || TAG_CLOSE_RE.exec(rest);
  if (m) return { node: { t: 3, s: m[0] }, end: i + m[0].length };
  return null;
}

/** Email pattern without the trailing lookahead (for the emphasis fallback). */
const EMAIL_FULL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/;

/**
 * True when the delimiter run of `ch` starting at `end` closes an
 * emphasis whose opener appears before `start` in `src`. Used for an
 * email autolink at the end of an emphasis span: the emphasis is
 * tokenised before the autolink there, so the closing delimiter does
 * not count as a word character after the address.
 */
function closesEmphasis(src, start, end, ch) {
  if (src[end] !== ch) return false;
  let k = end;
  while (k < src.length && src[k] === ch) k++;
  const len = k - end;
  const { left, right } = flanking(src, end, len);
  const canClose = ch === '*' ? right : right && (!left || isPunct(src[end + len] || ''));
  if (!canClose) return false;
  // Count unmatched openers of `ch` before `start`.
  let open = 0;
  let p = 0;
  while (p < start) {
    if (src[p] === ch) {
      let q = p;
      while (q < start && src[q] === ch) q++;
      const runLen = q - p;
      const fl = flanking(src, p, runLen);
      const cOpen = ch === '*' ? fl.left : fl.left && (!fl.right || isPunct(p > 0 ? src[p - 1] : ''));
      const cClose = ch === '*' ? fl.right : fl.right && (!fl.left || isPunct(q < src.length ? src[q] : ''));
      if (cClose && open > 0) open--;
      else if (cOpen) open++;
      p = q;
    } else {
      p++;
    }
  }
  return open > 0;
}

/** Try a GFM extended autolink (www. / scheme:// / email / mailto:) at `i`. */
function tryUrl(src, i, inLink) {
  if (inLink || docInLink) return null;
  const rest = src.slice(i);
  const m = URL_RE.exec(rest);
  if (m && m[2] === '@') {
    // The lookahead may have truncated the address when it is followed
    // by an emphasis delimiter; retry without it in that case.
    const fm = EMAIL_FULL_RE.exec(rest);
    if (fm && fm[0].length > m[0].length) {
      const after = src[i + fm[0].length];
      if (after === '_' || after === '*') {
        if (closesEmphasis(src, i, i + fm[0].length, after)) {
          return {
            node: { t: 6, href: 'mailto:' + fm[0], title: null, kids: null, img: false, autolink: true, text: fm[0] },
            end: i + fm[0].length,
          };
        }
      }
    }
  }
  if (!m) {
    // No match at all: an email inside an emphasis span may have been
    // rejected by the lookahead.
    const fm = EMAIL_FULL_RE.exec(rest);
    if (fm) {
      const after = src[i + fm[0].length];
      if ((after === '_' || after === '*') && closesEmphasis(src, i, i + fm[0].length, after)) {
        return {
          node: { t: 6, href: 'mailto:' + fm[0], title: null, kids: null, img: false, autolink: true, text: fm[0] },
          end: i + fm[0].length,
        };
      }
    }
    return null;
  }
  const full = m[0];
  // The url regex is only tried where the reference's text token would
  // stop: a scheme link anywhere, a www. link only after whitespace,
  // '*', '_', '~', '(' or the start, and an email only at the start of
  // its local part.
  if (m[1] !== undefined) {
    // scheme:// or www.
    if (m[1].toLowerCase() === 'www.') {
      if (i > 0) {
        const prev = src[i - 1];
        if (!(prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(')) return null;
      }
    }
    let text = full;
    let guard = 0;
    while (guard++ < 10) {
      const b = BACKPEDAL_RE.exec(text);
      const trimmed = b ? b[0] : '';
      if (trimmed === text) break;
      text = trimmed;
    }
    if (text === '') return null;
    const href = m[1].toLowerCase() === 'www.' ? 'http://' + text : text;
    return {
      node: { t: 6, href, title: null, kids: null, img: false, autolink: true, text },
      end: i + text.length,
    };
  }
  if (m[2] === '@') {
    return {
      node: { t: 6, href: 'mailto:' + full, title: null, kids: null, img: false, autolink: true, text: full },
      end: i + full.length,
    };
  }
  // mailto:/xmpp: autolink.
  return {
    node: { t: 6, href: full, title: null, kids: null, img: false, autolink: true, text: full },
    end: i + full.length,
  };
}

/**
 * True when the '_' or '*' run ending just before `i` is an emphasis
 * delimiter (it can open or close), so `i` starts a fresh token.
 */
function isDelimRunBefore(src, i) {
  const ch = src[i - 1];
  if (ch !== '_' && ch !== '*') return false;
  let s = i - 1;
  while (s > 0 && src[s - 1] === ch) s--;
  const len = i - s;
  const { left, right } = flanking(src, s, len);
  if (ch === '*') return left || right;
  return (left && (!right || isPunct(s > 0 ? src[s - 1] : ''))) ||
    (right && (!left || isPunct(i < src.length ? src[i] : '')));
}

/** Compute flanking flags for a delimiter run at `i` with length `len`. */
function flanking(src, i, len) {
  const before = i > 0 ? src[i - 1] : '';
  const after = i + len < src.length ? src[i + len] : '';
  const beforeWs = isWs(before);
  const afterWs = isWs(after);
  const beforePunct = isPunct(before);
  const afterPunct = isPunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right };
}

/** Scan inline content into a node list (no emphasis processing yet). */
function inlineNodes(src, refs, inLink) {
  const nodes = [];
  const n = src.length;
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf !== '') {
      nodes.push({ t: 0, s: buf });
      buf = '';
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      // Hard break: two or more spaces before the newline.
      let k = buf.length;
      let spaces = 0;
      while (k > 0 && buf[k - 1] === ' ') {
        spaces++;
        k--;
      }
      if (spaces >= 2) {
        buf = buf.slice(0, k);
        flush();
        nodes.push({ t: 4 });
        i++;
        // A hard break swallows the next line's leading spaces/tabs.
        while (src[i] === ' ' || src[i] === '\t') i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ t: 4 });
        i += 2;
        // A hard break swallows the next line's leading spaces/tabs.
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        flush();
        nodes.push({ t: 1, s: nx });
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const run = k - i;
      const close = findCodeClose(src, k, run);
      if (close >= 0) {
        let content = src.slice(k, close).replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content[0] === ' ' &&
          content[content.length - 1] === ' ' &&
          content.trim() !== ''
        ) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ t: 2, s: content });
        i = close + run;
        continue;
      }
      buf += src.slice(i, k);
      i = k;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const link = tryLink(src, i, refs);
      if (link) {
        flush();
        nodes.push(link.node);
        i = link.end;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '<') {
      const ang = tryAngle(src, i);
      if (ang) {
        flush();
        nodes.push(ang.node);
        // An <a ...> tag (outside link text) sets the document-level
        // inLink state; </a> clears it (marked's tag tokenizer).
        if (!inLink && ang.node.t === 3) {
          if (!docInLink && START_A_TAG_RE.test(ang.node.s)) docInLink = true;
          else if (docInLink && END_A_TAG_RE.test(ang.node.s)) docInLink = false;
        }
        i = ang.end;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    if (c === '~') {
      // Strikethrough uses the delimiter stack, like emphasis: a run
      // of 1-2 tildes is a delimiter node; longer runs are literal.
      let k = i;
      while (k < n && src[k] === '~') k++;
      const len = k - i;
      if (len <= 2) {
        const { left, right } = flanking(src, i, len);
        const canOpen = left;
        const canClose = right;
        if (canOpen || canClose) {
          flush();
          nodes.push({ t: 9, ch: '~', len, canOpen, canClose });
        } else {
          buf += src.slice(i, k);
        }
      } else {
        buf += src.slice(i, k);
      }
      i = k;
      continue;
    }
    if (c === '*' || c === '_') {
      let k = i;
      while (k < n && src[k] === c) k++;
      const len = k - i;
      const { left, right } = flanking(src, i, len);
      let canOpen;
      let canClose;
      if (c === '*') {
        canOpen = left;
        canClose = right;
      } else {
        canOpen = left && (!right || isPunct(i > 0 ? src[i - 1] : ''));
        canClose = right && (!left || isPunct(i + len < n ? src[i + len] : ''));
      }
      if (canOpen || canClose) {
        flush();
        nodes.push({ t: 5, ch: c, len, canOpen, canClose });
      } else {
        buf += src.slice(i, k);
      }
      i = k;
      continue;
    }
    // GFM extended autolinks (suppressed inside a link, and while the
    // document-level inLink state is set by an unclosed <a> tag).
    if (!inLink && !docInLink) {
      let tryIt = false;
      if (c === 'w' || c === 'W') tryIt = src.slice(i, i + 4).toLowerCase() === 'www.';
      else if (c === 'h' || c === 'H' || c === 'f' || c === 'F') tryIt = SCHEME_RE.test(src.slice(i, i + 8));
      else if (c === 'm' || c === 'M' || c === 'x' || c === 'X') tryIt = MAILTO_RE.test(src.slice(i, i + 7));
      // A scheme/mailto lookalike that fails is still an email local
      // part start (e.g. "foo@bar.baz", "hello+xyz@mail.example").
      // The local part also starts after an emphasis delimiter run:
      // the '_'/'*' before it is a delimiter, not a local-part char.
      if (
        !tryIt &&
        EMAIL_LOCAL_RE.test(c) &&
        (i === 0 || !EMAIL_LOCAL_RE.test(src[i - 1]) || isDelimRunBefore(src, i)) &&
        src.indexOf('@', i) >= i
      ) {
        tryIt = true;
      }
      if (tryIt) {
        const url = tryUrl(src, i, inLink);
        if (url) {
          flush();
          nodes.push(url.node);
          i = url.end;
          continue;
        }
      }
    }
    // Bulk text run: append ordinary characters up to the next
    // structural character or URL/email trigger, instead of one char
    // at a time. A trigger is a structural character, "www.", a
    // scheme "://", "mailto:", or an "@" (for email, stop at the start
    // of the word that holds the "@").
    {
      SPECIAL_RE.lastIndex = i;
      const m = SPECIAL_RE.exec(src);
      let trigger = m ? m.index : n;
      const at = src.indexOf('@', i);
      if (at >= 0 && at < trigger) {
        // Stop at the start of the word holding the "@".
        let w = at;
        while (w > i && EMAIL_LOCAL_RE.test(src[w - 1])) w--;
        trigger = w;
      }
      // URL triggers: "www.", "://", "mailto:", "xmpp:" — all matched
      // lowercase ("www."/"mailto:"/"xmpp:" are lowercase-only; a
      // scheme is found via the "://" that follows it).
      const seg = src.slice(i, trigger);
      const www = seg.indexOf('www.');
      if (www >= 0) trigger = i + www;
      const scheme = seg.indexOf('://');
      if (scheme >= 0 && i + scheme < trigger) {
        let s = i + scheme;
        while (s > i && /[a-z]/i.test(src[s - 1])) s--;
        trigger = s;
      }
      const mailto = seg.indexOf('mailto:');
      if (mailto >= 0 && i + mailto < trigger) trigger = i + mailto;
      const xmpp = seg.indexOf('xmpp:');
      if (xmpp >= 0 && i + xmpp < trigger) trigger = i + xmpp;
      if (trigger > i) {
        buf += src.slice(i, trigger);
        i = trigger;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return nodes;
}

/** Whether the delimiter run at nodes[j] is followed by a
 * non-whitespace character (so it can open onto something). A run at
 * the end, or one followed by a space, is a pure closer. */
function followedByNonSpace(nodes, j) {
  const nx = nodes[j + 1];
  if (!nx) return false;
  if (nx.t === 0) return nx.s.length > 0 && !isWs(nx.s[0]);
  if (nx.t === 5 || nx.t === 9) return true; // followed by a delimiter char
  if (nx.t === 1) return nx.s.length > 0 && !isWs(nx.s[0]);
  if (nx.t === 2) return nx.s.length > 0 && !isWs(nx.s[0]);
  return true;
}

/** Emphasis / strikethrough, opener-driven like marked's emStrong/del.
 * Each opener is evaluated left to right: scan forward for a closer of
 * the same character. While scanning, an opener-only run (canOpen but
 * not canClose) adds its length to `m` — it must be closed too before
 * the closer can close this opener — and a both-open-and-close run is
 * skipped by the odd-match rule when (y + b) is a multiple of 3 but y
 * is not. A closer whose length does not bring `m` to zero or below
 * is skipped. When no closer is found the opener stays literal and is
 * never reconsidered (this is what leaves `*a **b**c*` unformed, where
 * a delimiter stack would close the outer `*` with the final `*`).
 * The node type follows marked: min(opener, closer) odd means em
 * (consume 1 delimiter each side), even means strong (consume 2);
 * the opener leftover stays inside the new node and is re-processed,
 * so `__foo_ bar_` becomes <em><em>foo</em> bar</em>; the closer is
 * shortened to b = min(len, len + m + f) and its remainder stays
 * outside as a literal run. A run with no closer gives up one
 * delimiter as literal text and retries the rest, so `**foo*` becomes
 * *<em>foo</em>. */
function processEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if ((node.t !== 5 && node.t !== 9) || !node.canOpen) {
      i++;
      continue;
    }
    // Scan forward for a closer for this opener.
    const y = node.len;
    let m = node.len;
    let f = 0;
    let closerIdx = -1;
    const other = node.ch === '*' ? '_' : node.ch === '_' ? '*' : null;
    for (let j = i + 1; j < nodes.length; j++) {
      const nd = nodes[j];
      if (nd.t !== 5 && nd.t !== 9) continue;
      // A run of the other delimiter that opens a strong region hides
      // any same-char run inside it (marked's RDelim skip): jump past
      // the region's closer.
      if (other && nd.ch === other && nd.len >= 2 && nd.canOpen && !nd.canClose) {
        let k = j + 1;
        let depth = 1;
        while (k < nodes.length) {
          const q = nodes[k];
          if ((q.t === 5 || q.t === 9) && q.ch === other) {
            if (q.canOpen && !q.canClose) depth++;
            else if (q.canClose) {
              depth--;
              if (depth === 0) break;
            }
          }
          k++;
        }
        if (k < nodes.length) {
          // Only skip when a same-char run sits inside the region.
          let inside = false;
          for (let p = j + 1; p < k; p++) {
            const q = nodes[p];
            if ((q.t === 5 || q.t === 9) && q.ch === node.ch) { inside = true; break; }
          }
          if (inside) {
            j = k;
            continue;
          }
        }
      }
      if (nd.ch !== node.ch) continue;
      if (!nd.canClose) {
        // An opener-only run: it must be closed too.
        if (nd.canOpen) m += nd.len;
        continue;
      }
      if (node.ch === '~') {
        // Strikethrough: the runs must have the same length.
        if (node.len !== nd.len) continue;
      } else if (nd.canOpen && followedByNonSpace(nodes, j)) {
        // Both open and close: the odd-match rule.
        if (y % 3 !== 0 && (y + nd.len) % 3 === 0) {
          f += nd.len;
          continue;
        }
      }
      m -= nd.len;
      if (m > 0) continue;
      closerIdx = j;
      break;
    }
    if (closerIdx < 0) {
      // No closer: give up one delimiter as literal text and retry
      // the rest of the run as a fresh opener.
      if (node.len > 1) {
        node.len -= 1;
        nodes.splice(i, 0, { t: node.t, ch: node.ch, len: 1, canOpen: false, canClose: false });
        i++;
        continue;
      }
      i++;
      continue;
    }
    const closer = nodes[closerIdx];
    // The closer is shortened to b (marked's b = min(b, b + m + f)).
    const b = node.ch === '~' ? closer.len : Math.min(closer.len, closer.len + m + f);
    const minLen = node.ch === '~' ? node.len : Math.min(node.len, b);
    const consume = node.ch === '~' ? node.len : (minLen % 2 === 1 ? 1 : 2);
    // Leftovers: the opener remainder and the closer remainder inside
    // b stay inside the new node; the closer remainder beyond b stays
    // outside as a literal run.
    const openLeft = node.len - consume;
    const closeLeftIn = b - consume;
    const closeLeftOut = closer.len - b;
    const kids = [];
    if (openLeft > 0) {
      node.len = openLeft;
      kids.push(node);
    }
    for (let k = i + 1; k < closerIdx; k++) kids.push(nodes[k]);
    if (closeLeftIn > 0) {
      kids.push({ t: closer.t, ch: closer.ch, len: closeLeftIn, canOpen: closer.canOpen, canClose: closer.canClose });
    }
    // Inner emphasis forms inside the new node.
    processEmphasis(kids);
    const newNode = node.ch === '~'
      ? { t: 6, href: null, title: null, kids, img: false, autolink: false, text: null, del: true }
      : { t: minLen % 2 === 1 ? 7 : 8, kids };
    const rep = [newNode];
    if (closeLeftOut > 0) {
      rep.push({ t: closer.t, ch: closer.ch, len: closeLeftOut, canOpen: closer.canOpen, canClose: closer.canClose });
    }
    nodes.splice(i, closerIdx - i + 1, ...rep);
    // The new node is complete (its inside is processed); continue
    // after it. A leftover closer outside it is re-examined as a
    // possible opener by the loop.
    i++;
  }
}

/** Render a node list to HTML. */
function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 0:
        out += escText(nd.s);
        break;
      case 1:
        out += escAll(nd.s);
        break;
      case 2:
        out += '<code>' + escAll(nd.s) + '</code>';
        break;
      case 3:
        out += nd.s;
        break;
      case 4:
        out += '<br>';
        break;
      case 5:
      case 9:
        out += escText(nd.ch.repeat(nd.len));
        break;
      case 6: {
        if (nd.del) {
          out += '<del>' + renderNodes(nd.kids) + '</del>';
          break;
        }
        if (nd.img) {
          const alt = plainText(nd.kids);
          const href = cleanUrl(nd.href);
          if (href === null) {
            out += escText(alt);
            break;
          }
          out += '<img src="' + escText(href) + '" alt="' + escText(alt) + '"';
          if (nd.title !== null && nd.title !== undefined) out += ' title="' + escText(nd.title) + '"';
          out += '>';
          break;
        }
        if (nd.autolink) {
          const href = cleanUrl(nd.href);
          if (href === null) {
            out += escAll(nd.text);
            break;
          }
          out += '<a href="' + escAll(href) + '">' + escAll(nd.text) + '</a>';
          break;
        }
        const href = cleanUrl(nd.href);
        if (href === null) {
          out += renderNodes(nd.kids);
          break;
        }
        out += '<a href="' + escText(href) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escText(nd.title) + '"';
        out += '>' + renderNodes(nd.kids) + '</a>';
        break;
      }
      case 7:
        out += '<em>' + renderNodes(nd.kids) + '</em>';
        break;
      case 8:
        out += '<strong>' + renderNodes(nd.kids) + '</strong>';
        break;
    }
  }
  return out;
}

/** Plain-text rendering of a node list (image alt text, before escaping). */
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 0:
        out += decodeRefs(nd.s);
        break;
      case 1:
        out += nd.s;
        break;
      case 2:
        out += nd.s;
        break;
      case 3:
        out += nd.s;
        break;
      case 4:
        out += '';
        break;
      case 5:
      case 9:
        out += nd.ch.repeat(nd.len);
        break;
      case 6:
        if (nd.del) out += plainText(nd.kids);
        else if (nd.img) out += plainText(nd.kids);
        else if (nd.autolink) out += nd.text;
        else out += plainText(nd.kids);
        break;
      case 7:
      case 8:
        out += plainText(nd.kids);
        break;
    }
  }
  return out;
}

/**
 * When true, inline rendering is skipped: the block walk runs only to
 * collect link reference definitions (the reference gathers them from
 * the whole document before any inline parsing, so a link may use a
 * definition that appears later in the document).
 */
let collectOnly = false;
// Document-level "inside an <a> tag" state (marked's lexer.state.inLink):
// an unclosed `<a ...>` tag suppresses GFM extended autolinks for the
// rest of the document, until a `</a>` is seen. Reset per parse().
let docInLink = false;
const START_A_TAG_RE = /^<a /i;
const END_A_TAG_RE = /^<\/a>/i;

/** Parse inline Markdown to HTML. */
function inlineHtml(src, refs) {
  if (src === '' || collectOnly) return '';
  const nodes = inlineNodes(src, refs, false);
  processEmphasis(nodes);
  return renderNodes(nodes);
}

// ---------------------------------------------------------------------------
// Block parsing helpers
// ---------------------------------------------------------------------------

/** Columns of leading indentation (a tab advances to the next multiple of 4). */
function indentCols(line) {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') cols++;
    else if (c === '\t') cols += 4 - (cols % 4);
    else break;
  }
  return cols;
}

/**
 * Remove up to `n` columns of indentation from a line. A tab that is only
 * partly consumed leaves spaces behind.
 */
function stripCols(line, n) {
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < n) {
    const c = line[i];
    if (c === ' ') {
      cols++;
      i++;
    } else if (c === '\t') {
      const w = 4 - (cols % 4);
      if (cols + w <= n) {
        cols += w;
        i++;
      } else {
        return ' '.repeat(cols + w - n) + line.slice(i + 1);
      }
    } else {
      break;
    }
  }
  return line.slice(i);
}

/**
 * Expand the tabs in a whitespace run to spaces, as if the run started
 * at absolute column `startCol` (a tab advances to the next multiple
 * of 4). This is the reference's tab model: a tab's width depends on
 * the column it starts at, so a partially consumed tab leaves spaces.
 */
function expandTabs(ws, startCol) {
  let col = startCol;
  let out = '';
  for (let i = 0; i < ws.length; i++) {
    const c = ws[i];
    if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ' ';
      col++;
    }
  }
  return out;
}

/** Expand the leading whitespace run of `s` (starting at `startCol`). */
function expandLeading(s, startCol) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i === 0) return s;
  return expandTabs(s.slice(0, i), startCol) + s.slice(i);
}

/** True when the line holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * ATX heading: returns { depth, content } or null. The content has its
 * leading spaces and a closing hash sequence removed.
 */
function atxHeading(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const rest = stripCols(line, ind);
  let h = 0;
  while (h < rest.length && rest[h] === '#') h++;
  if (h === 0 || h > 6) return null;
  if (h < rest.length && rest[h] !== ' ' && rest[h] !== '\t') return null;
  let content = rest.slice(h).trim();
  if (content.endsWith('#')) {
    let e = content.length;
    while (e > 0 && content[e - 1] === '#') e--;
    const stripped = content.slice(0, e);
    if (stripped === '' || stripped.endsWith(' ') || stripped.endsWith('\t')) {
      content = stripped.trim();
    }
  }
  return { depth: h, content };
}

/** Setext underline: 1 for '=', 2 for '-', else 0. Only a run of the
 * character followed by spaces/tabs counts; internal spaces reject it. */
function setextLevel(line) {
  const ind = indentCols(line);
  if (ind > 3) return 0;
  const rest = stripCols(line, ind);
  if (rest === '') return 0;
  const ch = rest[0];
  if (ch !== '=' && ch !== '-') return 0;
  let i = 1;
  while (i < rest.length && rest[i] === ch) i++;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
  if (i !== rest.length) return 0;
  return ch === '=' ? 1 : 2;
}

/** Thematic break. */
function isHr(line) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const rest = stripCols(line, ind);
  if (rest === '') return false;
  const ch = rest[0];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

/**
 * Fenced code start: { ch, len, info } or null. For backtick fences the
 * info string may not contain a backtick.
 */
function fenceStart(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const rest = stripCols(line, ind);
  if (rest === '') return null;
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < rest.length && rest[len] === ch) len++;
  if (len < 3) return null;
  const info = rest.slice(len);
  if (ch === '`' && info.includes('`')) return null;
  // The leading-whitespace string (for the Dt compensation, which
  // strips min(leading-ws chars, fence-indent chars) per content line).
  const indentStr = line.slice(0, line.length - rest.length);
  return { ch, len, info, indent: ind, indentStr };
}

/** Closing fence line for a fence of `ch` and length `len`. */
function isFenceClose(line, ch, len) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const rest = stripCols(line, ind);
  let n = 0;
  while (n < rest.length && rest[n] === ch) n++;
  if (n < len) return false;
  for (let i = n; i < rest.length; i++) {
    if (rest[i] !== ' ' && rest[i] !== '\t') return false;
  }
  return true;
}

const BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col colgroup dd ' +
    'details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
    'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta ' +
    'nav noframes ol optgroup option p param search section summary table tbody td tfoot ' +
    'th thead title tr track ul'
  ).split(' '),
);

/**
 * HTML block start: 1-7 by type, or 0. `allowTab` is true at block level
 * (a tab may follow a block tag name) and false where a line interrupts a
 * paragraph (there only a space may).
 */
function htmlStart(line, allowTab) {
  const ind = indentCols(line);
  if (ind > 3) return 0;
  const rest = stripCols(line, ind);
  if (rest === '' || rest[0] !== '<') return 0;
  const lower = rest.toLowerCase();
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith('<' + tag)) {
      const nx = rest[1 + tag.length];
      if (nx === undefined || nx === ' ' || nx === '\t' || nx === '>') return 1;
    }
  }
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<!') && rest.length > 2 && /[A-Za-z]/.test(rest[2])) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  // Type 6: a block-level tag.
  let j = 1;
  let closing = false;
  if (rest[j] === '/') {
    closing = true;
    j++;
  }
  let k = j;
  while (k < rest.length && /[A-Za-z0-9-]/.test(rest[k])) k++;
  if (k > j && rest[j] && /[A-Za-z]/.test(rest[j])) {
    const name = rest.slice(j, k).toLowerCase();
    if (BLOCK_TAGS.has(name)) {
      const nx = rest[k];
      if (
        nx === undefined ||
        nx === '>' ||
        (nx === '/' && rest[k + 1] === '>') ||
        nx === ' ' ||
        (allowTab && nx === '\t')
      ) {
        return 6;
      }
    }
  }
  // Type 7: any other complete tag, alone on the line.
  if (!closing) {
    // Open tag with attributes (spaces only between attributes).
    let p = 1;
    if (p < rest.length && /[A-Za-z]/.test(rest[p])) {
      let q = p;
      while (q < rest.length && /[A-Za-z0-9-]/.test(rest[q])) q++;
      const name = rest.slice(p, q).toLowerCase();
      if (name !== 'script' && name !== 'pre' && name !== 'style' && name !== 'textarea') {
        let ok = true;
        let r = q;
        while (ok) {
          // Skip spaces, then an optional attribute.
          let sp = r;
          while (rest[sp] === ' ') sp++;
          if (rest[sp] === '>') {
            r = sp + 1;
            break;
          }
          if (rest[sp] === '/' && rest[sp + 1] === '>') {
            r = sp + 2;
            break;
          }
          if (sp === r) {
            ok = false;
            break;
          }
          r = sp;
          if (!/[A-Za-z_:]/.test(rest[r] || '')) {
            ok = false;
            break;
          }
          while (r < rest.length && /[\w.:-]/.test(rest[r])) r++;
          // Optional = value.
          let v = r;
          while (rest[v] === ' ') v++;
          if (rest[v] === '=') {
            v++;
            while (rest[v] === ' ') v++;
            if (rest[v] === '"') {
              v++;
              while (v < rest.length && rest[v] !== '"' && rest[v] !== '\n') v++;
              if (rest[v] !== '"') {
                ok = false;
                break;
              }
              v++;
            } else if (rest[v] === "'") {
              v++;
              while (v < rest.length && rest[v] !== "'" && rest[v] !== '\n') v++;
              if (rest[v] !== "'") {
                ok = false;
                break;
              }
              v++;
            } else {
              const vs = v;
              while (
                v < rest.length &&
                rest[v] !== ' ' &&
                rest[v] !== '\t' &&
                rest[v] !== '"' &&
                rest[v] !== "'" &&
                rest[v] !== '=' &&
                rest[v] !== '<' &&
                rest[v] !== '>' &&
                rest[v] !== '`'
              ) {
                v++;
              }
              if (v === vs) {
                ok = false;
                break;
              }
            }
            r = v;
          }
        }
        if (ok) {
          let t = r;
          while (rest[t] === ' ' || rest[t] === '\t') t++;
          if (t >= rest.length) return 7;
        }
      }
    }
  } else {
    // Closing tag: </name> with optional whitespace, alone on the line.
    let q = j;
    while (q < rest.length && /[A-Za-z0-9-]/.test(rest[q])) q++;
    if (q > j && /[A-Za-z]/.test(rest[j])) {
      let r = q;
      while (rest[r] === ' ' || rest[r] === '\t') r++;
      if (rest[r] === '>') {
        r++;
        while (rest[r] === ' ' || rest[r] === '\t') r++;
        if (r >= rest.length) return 7;
      }
    }
  }
  return 0;
}

/** Does the line end an HTML block of `type` (types 1-5)? */
function htmlEnds(line, type, tag) {
  const lower = line.toLowerCase();
  switch (type) {
    case 1:
      return lower.includes('</' + tag + '>');
    case 2:
      return line.includes('-->');
    case 3:
      return line.includes('?>');
    case 4:
      return line.includes('>');
    case 5:
      return line.includes(']]>');
    default:
      return false;
  }
}

/** The tag name that opens a type-1 HTML block (script/pre/style/textarea). */
function htmlType1Tag(line) {
  const rest = stripCols(line, indentCols(line)).toLowerCase();
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (rest.startsWith('<' + tag)) return tag;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

/** Skip spaces and tabs from `i`. */
function skipSpacesTabs(s, i) {
  while (s[i] === ' ' || s[i] === '\t') i++;
  return i;
}

/**
 * Try to parse a link reference definition at `pos` in `text`
 * (text[pos] === '['). Returns { label, href, title, end } (end is the
 * index just past the definition's trailing spaces, before its newlines)
 * or null.
 */
function tryRefDef(text, pos, refs) {
  if (text[pos] !== '[') return null;
  const lab = scanDefLabel(text, pos);
  if (!lab) return null;
  if (lab.label.trim() === '') return null;
  let j = lab.end;
  if (text[j] !== ':') return null;
  j++;
  j = skipSpacesTabs(text, j);
  if (text[j] === '\n') {
    j++;
    j = skipSpacesTabs(text, j);
  }
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    while (k < text.length && text[k] !== '>' && text[k] !== '\n' && text[k] !== '<') k++;
    if (k >= text.length || text[k] !== '>') return null;
    dest = text.slice(j + 1, k);
    j = k + 1;
  } else {
    const start = j;
    while (j < text.length && text[j] !== ' ' && text[j] !== '\t' && text[j] !== '\n') j++;
    if (j === start) return null;
    dest = text.slice(start, j);
    // Balanced parentheses are required for a bare destination.
    let depth = 0;
    for (let p = 0; p < dest.length; p++) {
      if (dest[p] === '\\') {
        p++;
      } else if (dest[p] === '(') {
        depth++;
      } else if (dest[p] === ')') {
        depth--;
        if (depth < 0) return null;
      }
    }
    if (depth !== 0) return null;
  }
  // Optional title, on this line or the next. It needs whitespace (or a
  // newline) between the destination and itself.
  const destEnd = j;
  let title = null;
  let titleEnd = j;
  let hadWs = false;
  let k = skipSpacesTabs(text, j);
  if (k > j) hadWs = true;
  if (text[k] === '\n') {
    hadWs = true;
    k++;
    k = skipSpacesTabs(text, k);
  }
  if (hadWs && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const q = text[k];
    const close = q === '(' ? ')' : q;
    let m = k + 1;
    let ok = false;
    let bad = false;
    while (m < text.length) {
      const c = text[m];
      if (c === '\\') {
        m += 2;
        continue;
      }
      if (c === close) {
        ok = true;
        break;
      }
      if (q === '(' && c === '(') {
        bad = true;
        break;
      }
      if (q === "'" && c === '\n' && text[m + 1] === '\n') {
        bad = true;
        break;
      }
      m++;
    }
    if (ok) {
      title = text.slice(k + 1, m);
      titleEnd = m + 1;
    } else if (bad) {
      // An invalid title cannot be part of the definition.
      title = null;
    }
    // An unclosed title is simply not a title.
  }
  if (title !== null) {
    // A title only counts when nothing but spaces and a newline follow
    // it; otherwise the title is dropped and the definition ends after
    // the destination.
    let e = skipSpacesTabs(text, titleEnd);
    if (e >= text.length || text[e] === '\n') {
      return {
        label: normalizeLabel(lab.label),
        href: unescapePunct(dest),
        title: unescapePunct(title),
        end: e,
      };
    }
  }
  // No (usable) title: the definition ends after the destination, which
  // must be followed by spaces and a newline (or the end of the text).
  const e = skipSpacesTabs(text, destEnd);
  if (e < text.length && text[e] !== '\n') return null;
  return {
    label: normalizeLabel(lab.label),
    href: unescapePunct(dest),
    title: null,
    end: e,
  };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Split a table row line into cells, the way the reference does: an
 * unescaped pipe marks a split, a leading/trailing empty cell is dropped,
 * cells are trimmed and "\|" becomes "|". With `count`, the row is
 * truncated or padded with empty cells to that length.
 */
function splitCells(line, count) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue;
    // An unescaped pipe (even number of preceding backslashes) is a
    // cell boundary; an escaped pipe stays in the cell.
    let bs = 0;
    let p = i - 1;
    while (p >= 0 && line[p] === '\\') {
      bs++;
      p--;
    }
    if (bs % 2 === 0) {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  if (count !== undefined) {
    if (parts.length > count) parts.length = count;
    while (parts.length < count) parts.push('');
  }
  for (let i = 0; i < parts.length; i++) {
    parts[i] = parts[i].trim().replace(/\\\|/g, '|');
  }
  return parts;
}

/**
 * Parse a table delimiter row. Returns the alignments (null/left/center/
 * right per column) or null. The row must contain a ':' or a '|'.
 */
function parseDelimiter(line) {
  if (!line.includes(':') && !line.includes('|')) return null;
  let s = line;
  if (s.startsWith('|')) s = s.slice(1);
  if (/ \| *$/.test(s)) s = s.replace(/\| *$/, '');
  else if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = s.split('|');
  const align = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (/^ *-+: *$/.test(cell)) align.push('right');
    else if (/^ *:-+: *$/.test(cell)) align.push('center');
    else if (/^ *:-+ *$/.test(cell)) align.push('left');
    else align.push(null);
  }
  return align;
}

/** Does the line start a block that interrupts a paragraph? */
/**
 * True when `line` starts a new block (used for lazy continuations: a
 * lazy line must not start a block). Unlike interruptsParagraph, any
 * list marker counts, even an ordered marker not starting with 1.
 */
function startsBlock(line) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  if (atxHeading(line) !== null) return true;
  if (fenceStart(line) !== null) return true;
  if (isHr(line)) return true;
  const hs = htmlStart(line, false);
  if (hs >= 1 && hs <= 6) return true;
  const rest = stripCols(line, ind);
  if (rest.startsWith('>')) return true;
  const lm = listMarker(line);
  if (lm) {
    const after = line.slice(lm.indent + lm.markerLen);
    let k = 0;
    while (k < after.length && (after[k] === ' ' || after[k] === '\t')) k++;
    if (k >= after.length) return false;
    return true;
  }
  return false;
}

function interruptsParagraph(line, inItem) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  if (atxHeading(line) !== null) return true;
  if (fenceStart(line) !== null) return true;
  if (isHr(line)) return true;
  const hs = htmlStart(line, false);
  if (hs >= 1 && hs <= 6) return true;
  const rest = stripCols(line, ind);
  if (rest.startsWith('>')) return true;
  // A list interrupts a paragraph only when its first item has content
  // (a bare marker does not), and an ordered list only when it starts
  // with 1 — except inside a list item, where any ordered marker
  // starts a nested list and so interrupts.
  const lm = listMarker(line);
  if (lm) {
    const after = line.slice(lm.indent + lm.markerLen);
    let k = 0;
    while (k < after.length && (after[k] === ' ' || after[k] === '\t')) k++;
    if (k >= after.length) return false;
    if (lm.ordered) return inItem ? true : lm.num === 1;
    return true;
  }
  return false;
}

/**
 * A list marker at the start of a line: { ordered, bullet, num, delim,
 * markerLen, contentStart } or null. `markerLen` is the marker's width in
 * characters; `contentStart` is the column where the item content starts.
 */
function listMarker(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const rest = stripCols(line, ind);
  if (rest === '') return null;
  const c = rest[0];
  if (c === '-' || c === '*' || c === '+') {
    const nx = rest[1];
    if (nx === undefined || nx === ' ' || nx === '\t' || nx === '\n') {
      return { ordered: false, bullet: c, num: 0, delim: '', markerLen: 1, indent: ind };
    }
    return null;
  }
  if (c >= '0' && c <= '9') {
    let d = 0;
    while (d < rest.length && rest[d] >= '0' && rest[d] <= '9') d++;
    if (d > 9) return null;
    const delim = rest[d];
    if (delim !== '.' && delim !== ')') return null;
    const nx = rest[d + 1];
    if (nx === undefined || nx === ' ' || nx === '\t' || nx === '\n') {
      return {
        ordered: true,
        bullet: '',
        num: parseInt(rest.slice(0, d), 10),
        delim,
        markerLen: d + 1,
        indent: ind,
      };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Content indent (in columns) of a list item's content. */
function listContentIndent(line, lm) {
  const markerEndCol = lm.indent + lm.markerLen;
  const rest = stripCols(line, lm.indent);
  let j = lm.markerLen;
  let cols = markerEndCol;
  let width = 0;
  while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) {
    if (rest[j] === ' ') {
      cols++;
      width++;
    } else {
      const w = 4 - (cols % 4);
      cols += w;
      width += w;
    }
    j++;
  }
  if (j >= rest.length) return markerEndCol + 1;
  if (width >= 1 && width <= 4) return cols;
  return markerEndCol + 1;
}

/**
 * Strip a blockquote marker (up to 3 spaces, '>', one optional space).
 * The whitespace after '>' is expanded to spaces using the column the
 * marker prefix ends at, and then '>' plus one space is dropped, so the
 * remainder's leading whitespace is plain spaces.
 */
function stripBlockquoteMarker(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const rest = stripCols(line, ind);
  if (rest[0] !== '>') return null;
  let m = 1;
  while (m < rest.length && (rest[m] === ' ' || rest[m] === '\t')) m++;
  const expanded = expandTabs(rest.slice(1, m), ind + 1);
  return expanded.slice(1) + rest.slice(m);
}

/**
 * Does a table start at these two (already container-stripped) lines?
 * Returns { headerCells, align } or null.
 */
function tableInfo(headerLine, delimLine) {
  if (headerLine === undefined || delimLine === undefined) return null;
  const hi = indentCols(headerLine);
  if (hi > 3) return null;
  const header = stripCols(headerLine, hi);
  if (header === '') return null;
  const di = indentCols(delimLine);
  if (di > 3) return null;
  const delim = stripCols(delimLine, di);
  const headerCells = splitCells(header);
  const align = parseDelimiter(delim);
  if (!align || align.length !== headerCells.length) return null;
  return { headerCells, align };
}

/** A body row line ends a table when it starts another block. */
function tableRowEnds(line) {
  const ind = indentCols(line);
  // A code line ends the table, but only when there is content after
  // the indent (a whitespace-only line such as "\t" is a table row,
  // not code — marked's code pattern needs a [^\n] after the indent).
  if (ind >= 4 && !isBlank(line)) return true;
  if (atxHeading(line) !== null) return true;
  if (fenceStart(line) !== null) return true;
  if (isHr(line)) return true;
  const rest = stripCols(line, ind);
  if (rest.startsWith('>')) return true;
  if (listMarker(line) !== null) return true;
  const hs = htmlStart(line, false);
  if (hs >= 1 && hs <= 6) return true;
  return false;
}

/** Update the "a paragraph is in progress" flag after adding `line`. */
function updateInPara(inPara, line, nextLine) {
  if (isBlank(line)) return false;
  // An indented code line does not start a paragraph.
  if (!inPara && indentCols(line) >= 4) return false;
  if (interruptsParagraph(line)) return false;
  if (tableInfo(line, nextLine) !== null) return false;
  return true;
}

/**
 * True when the last non-blank line of `sub` starts a blockquote or a
 * list: a lazy line after such a line is fed back into that container.
 */
function endsWithContainer(sub) {
  for (let k = sub.length - 1; k >= 0; k--) {
    const l = sub[k];
    if (isBlank(l)) continue;
    return stripBlockquoteMarker(l) !== null || listMarker(l) !== null;
  }
  return false;
}

/**
 * Collect a blockquote's lines starting at `i`. Returns { sub, subLazy,
 * next }: the stripped lines, which of them are lazy continuations
 * (1 = a lazy document line, 2 = a lazy setext line indented by four
 * spaces so it stays paragraph text), and the index after the quote.
 * A blank line without a marker ends the quote.
 */
function collectBlockquote(lines, i, lazy) {
  const sub = [];
  const subLazy = [];
  let inPara = false;
  // A lazy line inside a fenced code block does not continue the quote:
  // the fence's content lines are not paragraph text.
  let fenceCh = null;
  let fenceLen = 0;
  let j = i;
  const n = lines.length;
  while (j < n) {
    const line = lines[j];
    const stripped = stripBlockquoteMarker(line);
    if (stripped !== null) {
      sub.push(stripped);
      subLazy.push(0);
      if (fenceCh === null) {
        const f = fenceStart(stripped);
        if (f) {
          fenceCh = f.ch;
          fenceLen = f.len;
        }
      } else if (isFenceClose(stripped, fenceCh, fenceLen)) {
        fenceCh = null;
        fenceLen = 0;
      }
      const nextLine = j + 1 < n ? stripBlockquoteMarker(lines[j + 1]) ?? lines[j + 1] : undefined;
      inPara = fenceCh !== null ? false : updateInPara(inPara, stripped, nextLine);
      j++;
      continue;
    }
    if (isBlank(line)) break;
    // A lazy continuation: while a paragraph is in progress, or after
    // a nested blockquote or list (the line is fed back into it). A
    // lazy line must not start a new block of its own, and it never
    // continues a fenced code block.
    if (fenceCh === null && (inPara || endsWithContainer(sub)) && !startsBlock(line)) {
      const nextLine = j + 1 < n ? stripBlockquoteMarker(lines[j + 1]) ?? lines[j + 1] : undefined;
      if (tableInfo(line, nextLine) === null) {
        // A lazy setext underline is indented by four spaces so it
        // stays paragraph text instead of becoming a heading.
        if (setextLevel(line) > 0) {
          const ind = indentCols(line);
          sub.push('    ' + stripCols(line, ind));
          subLazy.push(2);
        } else {
          sub.push(line);
          subLazy.push(1);
        }
        inPara = true;
        j++;
        continue;
      }
    }
    break;
  }
  return { sub, subLazy, next: j };
}

/**
 * Parse the blocks in `lines` to HTML. `opts.tight` renders paragraphs
 * bare (inside a tight list item); `opts.eol` is true only for the
 * document's own lines when the source ends with a newline; `opts.lazy`
 * marks lazy continuation lines. When `looseOut` is given, its `v` is
 * set when a blank line separates two blocks at this level (a list item
 * with such a blank is loose).
 */
function parseBlocks(lines, refs, opts, looseOut) {
  const tight = opts.tight || false;
  const lazy = opts.lazy || null;
  const eol = opts.eol || false;
  let out = '';
  let i = 0;
  const n = lines.length;
  let pendingBlank = false;
  let blocksEmitted = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      pendingBlank = true;
      i++;
      continue;
    }
    if (pendingBlank && blocksEmitted > 0 && looseOut) looseOut.v = true;
    pendingBlank = false;
    blocksEmitted++;
    const ind = indentCols(line);
    // Indented code (checked first: it wins over every other block).
    if (ind >= 4) {
      let j = i;
      let lastCode = i;
      while (j < n) {
        if (isBlank(lines[j])) {
          j++;
        } else if (indentCols(lines[j]) >= 4) {
          lastCode = j;
          j++;
        } else {
          break;
        }
      }
      // In the collect pass code blocks cannot hold definitions, so
      // only advance past them.
      if (!collectOnly) {
        const content = [];
        for (let k = i; k <= lastCode; k++) {
          content.push(stripCols(lines[k], 4));
        }
        out += renderCode(content.join('\n'), '');
      }
      i = lastCode + 1;
      continue;
    }
    // Blockquote.
    if (stripBlockquoteMarker(line) !== null) {
      const { sub, subLazy, next } = collectBlockquote(lines, i, lazy);
      if (collectOnly) {
        parseBlocks(sub, refs, { tight: false, eol: false, lazy: subLazy });
      } else {
        out +=
          '<blockquote>\n' +
          parseBlocks(sub, refs, { tight: false, eol: false, lazy: subLazy }) +
          '</blockquote>\n';
      }
      i = next;
      continue;
    }
    // Thematic break (before the list: a line like "- - -" is an hr,
    // not a list item).
    if (isHr(line)) {
      if (!collectOnly) out += '<hr>\n';
      i++;
      continue;
    }
    // List.
    const lm = listMarker(line);
    if (lm !== null) {
      const res = parseList(lines, i, refs, opts);
      out += res.html;
      i = res.next;
      continue;
    }
    // ATX heading.
    const atx = atxHeading(line);
    if (atx !== null) {
      if (!collectOnly) out += '<h' + atx.depth + '>' + inlineHtml(atx.content, refs) + '</h' + atx.depth + '>\n';
      i++;
      continue;
    }
    // Fenced code.
    const fence = fenceStart(line);
    if (fence !== null) {
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j], fence.ch, fence.len)) j++;
      if (!collectOnly) {
        const content = [];
        // Marked's Dt compensation applies only to backtick fences
        // (indentCodeCompensation is /^(\s+)(?:```)/): strip
        // min(leading-whitespace chars, fence-indent chars) from each
        // content line. Tilde fences keep their content lines as-is.
        const sLen = fence.ch === '`' ? fence.indentStr.length : 0;
        for (let k = i + 1; k < j; k++) {
          const cl = lines[k];
          if (sLen === 0) { content.push(cl); continue; }
          const m = /^\s+/.exec(cl);
          content.push(m === null ? cl : cl.slice(Math.min(m[0].length, sLen)));
        }
        const info = fence.info.trim();
        const lang = info === '' ? '' : unescapePunct(info).match(/^\S*/)[0];
        out += renderCode(content.join('\n'), lang);
      }
      i = j < n ? j + 1 : j;
      continue;
    }
    // HTML block.
    const hs = htmlStart(line, true);
    if (hs >= 1) {
      let j = i;
      if (hs === 1) {
        const tag = htmlType1Tag(line);
        while (j < n) {
          const ends = htmlEnds(lines[j], 1, tag);
          j++;
          if (ends) break;
        }
      } else if (hs >= 2 && hs <= 5) {
        while (j < n) {
          const ends = htmlEnds(lines[j], hs, '');
          j++;
          if (ends) break;
        }
      } else {
        while (j < n && !isBlank(lines[j])) j++;
      }
      // In the collect pass an HTML block cannot hold definitions.
      if (!collectOnly) {
        let text = lines.slice(i, j).join('\n');
        // Trailing newline (marked's ge()): types 1-5 end at a terminator
        // line, and keep one trailing newline when the line after the
        // block is a real line (only a truly empty line trims it — a
        // spaces/tabs line is real, since the html regex only consumes
        // newlines after the terminator), or at EOF when the source ends
        // with a newline. Types 6-7 end at a blank line, so they keep no
        // trailing newline (at EOF they follow the eol rule).
        if (hs >= 6) {
          if (j >= n && eol) text += '\n';
        } else if (j < n ? lines[j] !== '' : eol) {
          text += '\n';
        }
        out += text;
      }
      i = j;
      continue;
    }
    // Table.
    if (i + 1 < n) {
      const ti = tableInfo(line, lines[i + 1]);
      if (ti !== null) {
        let j = i + 2;
        // In the collect pass a table cannot hold definitions; only
        // find where its rows end.
        if (collectOnly) {
          while (j < n) {
            const rl = lines[j];
            if (/^ *$/.test(rl) || tableRowEnds(rl)) break;
            j++;
          }
          i = j;
          continue;
        }
        const rows = [];
        while (j < n) {
          const rl = lines[j];
          // A body row ends at a spaces-only line (marked's table body
          // regex uses ` *\n`); a line containing a tab is a row.
          if (/^ *$/.test(rl) || tableRowEnds(rl)) break;
          rows.push(splitCells(stripCols(rl, indentCols(rl)), ti.headerCells.length));
          j++;
        }
        out += renderTable(ti, rows, refs);
        i = j;
        continue;
      }
    }
    // Paragraph.
    const res = parseParagraph(lines, i, refs, opts);
    out += res.html;
    i = res.next;
  }
  return out;
}

/** Render a code block's content (with the reference's newline rule). */
function renderCode(text, lang) {
  const body = text === '' ? '' : text.replace(/\n$/, '') + '\n';
  if (lang !== '') {
    return '<pre><code class="language-' + escText(lang) + '">' + escAll(body) + '</code></pre>\n';
  }
  return '<pre><code>' + escAll(body) + '</code></pre>\n';
}

/** Render a table. */
function renderTable(ti, rows, refs) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < ti.headerCells.length; c++) {
    const a = ti.align[c];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineHtml(ti.headerCells[c], refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (rows.length > 0) {
    out += '<tbody>';
    for (const row of rows) {
      out += '<tr>\n';
      for (let c = 0; c < row.length; c++) {
        const a = ti.align[c];
        out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineHtml(row[c], refs) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

/**
 * Parse a paragraph starting at `i`: collect its lines, strip leading
 * link reference definitions, and render it (or a setext heading, or
 * nothing when it was only definitions).
 */
function parseParagraph(lines, i, refs, opts) {
  const tight = opts.tight || false;
  const lazy = opts.lazy || null;
  const eol = opts.eol || false;
  const n = lines.length;
  let j = i;
  const paraLines = [];
  let setextTaken = false;
  while (j < n) {
    const line = lines[j];
    if (isBlank(line)) {
      // A whitespace-only last line with no newline after it is a
      // paragraph continuation, not a blank line (an empty last line
      // is still a blank line).
      if (line !== '' && j === n - 1 && !eol) {
        paraLines.push(line);
        j++;
      }
      break;
    }
    if (j > i) {
      const isLazyLine = lazy !== null && lazy[j] !== 0;
      if (setextLevel(line) > 0 && !isLazyLine) {
        // A setext underline: it ends the paragraph and converts it.
        paraLines.push(line);
        j++;
        setextTaken = true;
        break;
      }
      if (interruptsParagraph(line, opts.inItem)) break;
      if (!isLazyLine && j + 1 < n && tableInfo(line, lines[j + 1]) !== null) break;
    }
    // A lazy document line with four or more columns of indent is
    // re-read as a code block and merged into the paragraph with its
    // indent removed (a setext line indented by the quote keeps it).
    if (lazy !== null && lazy[j] === 1 && indentCols(line) >= 4) {
      paraLines.push(stripCols(line, 4));
    } else {
      paraLines.push(line);
    }
    j++;
  }
  // Strip leading link reference definitions.
  let text = paraLines.join('\n');
  let pos = 0;
  let anyDef = false;
  while (pos < text.length) {
    // Up to three spaces may precede a definition's label.
    let p = pos;
    while (p < text.length && text[p] === ' ' && p - pos < 3) p++;
    const def = tryRefDef(text, p, refs);
    if (!def) break;
    anyDef = true;
    if (!refs.has(def.label)) {
      refs.set(def.label, { href: def.href, title: def.title });
    }
    pos = def.end;
    // Count the newlines after the definition.
    let nl = 0;
    while (text[pos] === '\n') {
      nl++;
      pos++;
    }
    if (nl >= 2 || pos >= text.length) {
      pos = text.length;
      break;
    }
    // One newline: another definition or the paragraph text may follow.
  }
  if (pos >= text.length) return { html: '', next: j };
  text = text.slice(pos);
  // Setext heading: the last line is an underline (and it is not lazy).
  const lines2 = text.split('\n');
  const lastIdx = lines2.length - 1;
  const lastLine = lines2[lastIdx];
  const lvl = setextLevel(lastLine);
  const lastIsLazy = lazy !== null && lazy[j - 1] !== 0;
  if (lvl > 0 && lines2.length > 1 && !lastIsLazy) {
    const headText = lines2.slice(0, lastIdx).join('\n').trim();
    return {
      html:
        '<h' + lvl + '>' + inlineHtml(headText, refs) + '</h' + lvl + '>\n',
      next: j,
    };
  }
  if (setextTaken && lvl > 0 && lines2.length === 1 && !lastIsLazy) {
    // Definitions consumed every line but the underline: re-process it
    // as its own block (an hr for "---", a paragraph for "===").
    return { html: '', next: j - 1 };
  }
  const html = inlineHtml(text, refs);
  if (tight) return { html, next: j };
  return { html: '<p>' + html + '</p>\n', next: j };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Strip a list item's content indent from a continuation line: expand
 * its leading whitespace to spaces (from column 0) and drop the first
 * `contentIndent` columns. Returns null when the line is not indented
 * enough to belong to the item.
 */
function stripItemLine(line, contentIndent) {
  const z = expandLeading(line, 0);
  let p = 0;
  while (p < z.length && z[p] === ' ') p++;
  if (p >= contentIndent) return z.slice(contentIndent);
  return null;
}

/**
 * True when a lazy line may follow `prev` (the item's last line): the
 * previous line is not blank, is not indented by four or more columns,
 * and does not start a fence, a heading, an HTML block, or a break.
 */
function listCanLazy(prev) {
  if (prev === '' || isBlank(prev)) return false;
  const expanded = expandLeading(prev, 0);
  let p = 0;
  while (p < expanded.length && expanded[p] === ' ') p++;
  if (p >= 4) return false;
  if (fenceStart(prev) !== null) return false;
  if (atxHeading(prev) !== null) return false;
  if (isHr(prev)) return false;
  const hs = htmlStart(prev, false);
  if (hs >= 1 && hs <= 6) return false;
  return true;
}

/**
 * Parse a list starting at `i`. Returns { html, next }.
 */
function parseList(lines, i, refs, opts) {
  const first = listMarker(lines[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const bullet = first.bullet;
  const startNum = first.num;
  const items = [];
  let loose = false;
  let j = i;
  const n = lines.length;
  // A marker is a sibling item of this list only when its indent is
  // below the previous item's content indent; at or beyond it, the
  // marker starts a nested list inside that item.
  let prevContentIndent = -1;
  while (j < n) {
    const line = lines[j];
    if (isHr(line)) break;
    const lm = listMarker(line);
    if (
      lm === null ||
      lm.ordered !== ordered ||
      (ordered ? lm.delim !== delim : lm.bullet !== bullet) ||
      (prevContentIndent >= 0 && lm.indent >= prevContentIndent)
    ) {
      break;
    }
    // The marker's length in columns (leading indent + marker chars) is
    // the column the content starts at. Expand the content's leading
    // whitespace from that column, then the content indent is the first
    // non-space column of the expanded text (capped: more than 4 means
    // the content starts one column after the marker).
    const b = lm.indent + lm.markerLen;
    const g = line.slice(b);
    const m = expandLeading(g, b);
    let contentIndent;
    let firstText;
    if (!m.trim()) {
      contentIndent = b + 1;
      firstText = '';
    } else {
      let r = 0;
      while (r < m.length && m[r] === ' ') r++;
      if (r > 4) r = 1;
      firstText = m.slice(r);
      contentIndent = r + b;
    }
    const itemLines = [firstText];
    const itemLazy = [0];
    let inPara = updateInPara(false, itemLines[0], undefined);
    let k = j + 1;
    let sawContent = itemLines[0] !== '';
    prevContentIndent = contentIndent;
    // An empty first line followed by a blank line ends the item. If
    // another item of this list follows, the list continues (loose);
    // otherwise the list ends here.
    if (firstText === '' && k < n && isBlank(lines[k])) {
      let m2 = k + 1;
      while (m2 < n && isBlank(lines[m2])) m2++;
      items.push({ lines: [], lazy: [] });
      if (m2 < n) {
        const lm2 = listMarker(lines[m2]);
        if (
          lm2 !== null &&
          lm2.ordered === ordered &&
          (ordered ? lm2.delim === delim : lm2.bullet === bullet) &&
          lm2.indent < contentIndent &&
          !isHr(lines[m2])
        ) {
          loose = true;
          j = m2;
          continue;
        }
      }
      j = k;
      continue;
    }
    while (k < n) {
      const l2 = lines[k];
      if (isBlank(l2)) {
        // Look ahead for the next non-blank line.
        let m2 = k + 1;
        while (m2 < n && isBlank(lines[m2])) m2++;
        if (m2 >= n) break;
        const lm2 = listMarker(lines[m2]);
        if (
          lm2 !== null &&
          lm2.ordered === ordered &&
          (ordered ? lm2.delim === delim : lm2.bullet === bullet) &&
          lm2.indent < contentIndent &&
          !isHr(lines[m2])
        ) {
          // A blank line before the next item of this list: loose,
          // and the list continues with that item.
          loose = true;
          k = m2;
          break;
        }
        if (stripItemLine(lines[m2], contentIndent) !== null) {
          // The item continues after the blank line(s).
          while (k < m2) {
            itemLines.push('');
            itemLazy.push(0);
            k++;
          }
          inPara = false;
          continue;
        }
        break;
      }
      const stripped = stripItemLine(l2, contentIndent);
      if (stripped !== null) {
        itemLines.push(stripped);
        itemLazy.push(0);
        const nextLine =
          k + 1 < n ? stripItemLine(lines[k + 1], contentIndent) ?? lines[k + 1] : undefined;
        inPara = updateInPara(inPara, stripped, nextLine);
        sawContent = true;
        k++;
        continue;
      }
      // Lazy continuation: the previous item line is not blank, not
      // indented by four or more columns, and does not start a fence,
      // a heading, an HTML block, or a thematic break. A list marker
      // ends the item instead of continuing it.
      if (
        listCanLazy(itemLines[itemLines.length - 1]) &&
        !startsBlock(l2) &&
        !(listMarker(l2) !== null && indentCols(l2) <= contentIndent)
      ) {
        const nextLine =
          k + 1 < n ? stripItemLine(lines[k + 1], contentIndent) ?? lines[k + 1] : undefined;
        if (tableInfo(l2, nextLine) === null) {
          itemLines.push(l2);
          itemLazy.push(1);
          sawContent = true;
          k++;
          continue;
        }
      }
      break;
    }
    // Drop trailing blank lines from the item's content.
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') {
      itemLines.pop();
      itemLazy.pop();
    }
    items.push({ lines: itemLines, lazy: itemLazy });
    j = k;
  }
  // A list is loose when a blank line separates two items (tracked
  // above) or two blocks inside an item. The latter is found by walking
  // each item's lines once without inline rendering: a blank line
  // inside a nested block does not make the outer item loose.
  // In the collect pass the rendered HTML is discarded, so only walk
  // each item once (to collect definitions) and skip the probe/render.
  if (collectOnly) {
    for (const item of items) {
      if (item.lines.length === 0) continue;
      parseBlocks(item.lines, refs, { tight: false, eol: false, lazy: item.lazy, inItem: true });
    }
    return { html: '', next: j };
  }
  let isLoose = loose;
  if (!isLoose) {
    for (const item of items) {
      if (item.lines.length === 0) continue;
      const probe = { v: false };
      const saved = collectOnly;
      collectOnly = true;
      parseBlocks(item.lines, refs, { tight: false, eol: false, lazy: item.lazy, inItem: true }, probe);
      collectOnly = saved;
      if (probe.v) {
        isLoose = true;
        break;
      }
    }
  }
  // Render.
  let out = ordered ? '<ol' + (startNum !== 1 ? ' start="' + startNum + '"' : '') + '>\n' : '<ul>\n';
  for (const item of items) {
    let inner = parseBlocks(item.lines, refs, {
      tight: !isLoose,
      eol: false,
      lazy: item.lazy,
      inItem: true,
    });
    // Task list item: a checkbox at the start of the first paragraph
    // (which may be wrapped in <p> when the list is loose).
    const m = /^((?:<p>)?)\[( |x|X)\][ \t]+(\S)/.exec(inner);
    if (m) {
      const checked = m[2] === 'x' || m[2] === 'X';
      const after = inner.slice(m[0].length - 1);
      inner =
        m[1] +
        '<input ' +
        (checked ? 'checked="" ' : '') +
        'disabled="" type="checkbox"> ' +
        after;
    }
    out += '<li>' + inner + '</li>\n';
  }
  out += ordered ? '</ol>\n' : '</ul>\n';
  return { html: out, next: j };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render `markdown` to HTML exactly as marked 18.1.3 does with its
 * default options.
 */
export function parse(markdown) {
  let src = typeof markdown === 'string' ? markdown : String(markdown);
  if (src.indexOf('\r') >= 0) src = src.replace(/\r\n?/g, '\n');
  const eol = src.endsWith('\n');
  let lines = src.split('\n');
  if (eol) lines.pop();
  const refs = new Map();
  docInLink = false;
  // First pass: collect every link reference definition in the document.
  collectOnly = true;
  parseBlocks(lines, refs, { tight: false, eol, lazy: null });
  // Second pass: render with the complete definition map.
  collectOnly = false;
  return parseBlocks(lines, refs, { tight: false, eol, lazy: null });
}
