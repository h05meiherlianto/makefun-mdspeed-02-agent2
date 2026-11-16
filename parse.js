// parse.js — a dependency-free markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders
// with its default options (GFM on, breaks off, pedantic off), for every
// input. The rendering algorithm is my own implementation, written from
// the CommonMark 0.31.2 and GFM 0.29 specifications and from marked's
// publicly documented behaviour; the two-pass design (block pass, then
// inline pass over queued text) mirrors the architecture every
// CommonMark renderer uses, because link reference definitions may appear
// anywhere in the document and must apply to text that precedes them.
//
// Design notes:
// - The block pass walks the source once, top to bottom, matching one
//   block construct at a time (blank lines, indented and fenced code,
//   ATX and setext headings, thematic breaks, blockquotes, lists, raw
//   HTML blocks, link definitions, tables, paragraphs, plain text).
// - The inline pass is a scanner: at each position it tries, in order,
//   backslash escapes, raw HTML tags, links, reference links, emphasis,
//   code spans, hard breaks, strikethrough, autolinks and GFM extended
//   URLs, and otherwise consumes a run of plain text.
// - Emphasis follows the delimiter-run rules of CommonMark, with the
//   masking pass that hides link labels, code spans and HTML tags from
//   the closer search, so a delimiter inside a link label or a code span
//   can never close emphasis that started outside it.
//
// MIT License — see LICENSE. marked itself is MIT-licensed; this file is
// an independent implementation and shares no code with it.

'use strict';

// ---------------------------------------------------------------------------
// Pattern builder
//
// Several of the grammars below are assembled from named fragments. The
// builder keeps a pattern string and splices fragments into it; a fragment
// that carries its own start-of-input anchor loses that anchor when it is
// spliced into the middle of a larger pattern, exactly as it must, since
// the anchor only makes sense at the start of the fragment's own match.
const CARET_STRIP = /(^|[^\[])\^/g;

function buildRx(source, flags = '') {
  let pattern = typeof source === 'string' ? source : source.source;
  const api = {
    replace(search, fragment) {
      let piece = typeof fragment === 'string' ? fragment : fragment.source;
      piece = piece.replace(CARET_STRIP, '$1');
      pattern = pattern.replace(search, piece);
      return api;
    },
    regex() {
      return new RegExp(pattern, flags);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Shared small patterns ("other" rules)

const RX_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RX_LINK_BRACKET_ESC = /\\([\[\]])/g;
const RX_FENCE_INDENT = /^(\s+)(?:```)/;
const RX_LEAD_SPACE = /^\s+/;
const RX_END_HASH = /#$/;
const RX_START_SPACE = /^ /;
const RX_END_SPACE = / $/;
const RX_END_SPACE_TAB = /[ \t]$/;
const RX_NON_SPACE = /[^ ]/;
const RX_NEWLINE_G = /\n/g;
const RX_TAB_G = /\t/g;
const RX_LEAD_SPACE_TAB = /^[ \t]+/;
const RX_MULTI_SPACE_G = /\s+/g;
const RX_BLANK_LINE = /^[ \t]*$/;
const RX_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RX_BQ_START = /^ {0,3}>/;
const RX_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RX_BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RX_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RX_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const RX_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const RX_LIST_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const RX_TASK_BOX = /\[[ xX]\]/;
const RX_ANY_LINE = /\n.*\n/;
const RX_HREF_BRACKETS = /^<(.*)>$/;
const RX_TABLE_DELIM = /[:|]/;
const RX_TABLE_ALIGN_TRIM = /^\||\| *$/g;
const RX_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RX_ALIGN_RIGHT = /^ *-+: *$/;
const RX_ALIGN_CENTER = /^ *:-+: *$/;
const RX_ALIGN_LEFT = /^ *:-+ *$/;
const RX_START_A_TAG = /^<a /i;
const RX_END_A_TAG = /^<\/a>/i;
const RX_START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const RX_END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RX_START_ANGLE = /^</;
const RX_END_ANGLE = />$/;
const RX_ALNUM = /[\p{L}\p{N}]/u;
const RX_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RX_NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RX_ESC_TEST = /[&<>"']/;
const RX_ESC_REPLACE = /[&<>"']/g;
const RX_ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RX_ESC_REPLACE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RX_PERCENT = /%25/g;
const RX_PIPE_FIND = /\|/g;
const RX_PIPE_SPLIT = / \|/;
const RX_PIPE_ESC = /\\\|/g;
const RX_CR = /\r\n|\r/g;
const RX_SPACE_LINE = /^ +$/gm;
const RX_NOT_SPACE_START = /^\S*/;
const RX_END_NEWLINE = /\n$/;

// Tag names that start an HTML block (CommonMark's block-tag list).
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Indent-sensitive patterns are built per indent level and cached; the
// cache is keyed by the clamped indent (0-3), which is all the block
// grammar ever asks for.
function cacheByIndent(make) {
  const slots = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return slots[i] || (slots[i] = make(i));
  };
}
const nextBulletAt = cacheByIndent(
  (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`),
);
const hrAt = cacheByIndent(
  (n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
);
const fencesBeginAt = cacheByIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginAt = cacheByIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginAt = cacheByIndent(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
);
const blockquoteBeginAt = cacheByIndent((n) => new RegExp(`^ {0,${n}}>`));
const listItemRe = (bullet) => new RegExp(`^( {0,3}${bullet})((?:[ \t][^\n]*)?(?:\\n|$))`);

// ---------------------------------------------------------------------------
// Block grammar
//
// A paragraph is a run of lines that does not start a new block. Its
// pattern is assembled from the "paragraph core" below by plugging in the
// constructs that interrupt a paragraph.

const RX_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RX_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RX_INDENT_CODE =
  /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RX_FENCES =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RX_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RX_TEXT_LINE = /^[^\n]+/;
const RX_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const RX_LIST = buildRx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, RX_BULLET)
  .regex();

// The paragraph core: one or more lines, where a following line is only
// part of the paragraph when it does not start an interrupting construct.
const PARA_CORE =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

// A paragraph builder: plug the interrupting constructs into the core.
// `listRe` is the bullet pattern a paragraph may be interrupted by.
function buildParagraph(listRe) {
  return buildRx(PARA_CORE)
    .replace('hr', RX_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listRe)
    .replace(
      'html',
      ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    )
    .replace('tag', BLOCK_TAGS)
    .regex();
}

// The paragraph as it appears inside a blockquote match: any ordered list
// marker (not just "1.") may interrupt it.
const RX_PARA_IN_BQ = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
// The ordinary paragraph: only a list starting with "1" interrupts it.
const RX_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
const RX_BLOCKQUOTE = buildRx(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
)
  .replace('paragraph', RX_PARA_IN_BQ)
  .regex();

// Setext heading: a paragraph-like run of lines followed by = or -.
const RX_SETEXT = buildRx(
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
)
  .replace(/bull/g, RX_BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .regex();

// Table: header line, delimiter line, then body rows.
const RX_TABLE = buildRx(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
)
  .replace('hr', RX_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAGS)
  .regex();

// A GFM paragraph may also be interrupted by a table's delimiter row.
const RX_PARAGRAPH_GFM = buildRx(PARA_CORE)
  .replace('hr', RX_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', RX_TABLE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/)
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAGS)
  .regex();

// HTML comment, as used by the HTML block and inline tag rules.
const RX_HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// HTML block: type 1 (script/pre/style/textarea), type 2 (comment),
// type 3 (processing instruction), type 4 (declaration), type 5 (CDATA),
// type 6 (block tag), type 7 (any other tag on its own line).
const RX_HTML_BLOCK = buildRx(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
)
  .replace('comment', RX_HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace(
    'attribute',
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .regex();

// Link reference definition: [label]: destination "optional title".
// A label is bracketed text that may span lines but not blank lines.
const RX_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const RX_DEF = buildRx(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .replace('label', RX_LABEL)
  .replace(
    'title',
    /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
  )
  .regex();

// The block rules, in the order the block pass tries them.
const BLOCK = {
  newline: RX_NEWLINE,
  code: RX_INDENT_CODE,
  fences: RX_FENCES,
  heading: RX_HEADING,
  hr: RX_HR,
  blockquote: RX_BLOCKQUOTE,
  list: RX_LIST,
  html: RX_HTML_BLOCK,
  def: RX_DEF,
  table: RX_TABLE,
  lheading: RX_SETEXT,
  paragraph: RX_PARAGRAPH_GFM,
  text: RX_TEXT_LINE,
};

// ---------------------------------------------------------------------------
// Inline grammar
//
// Character classes for the delimiter rules. A "punctuation" character is
// any Unicode punctuation or symbol; "punct space" is whitespace or
// punctuation; "not punct space" is anything else. The tilde variants
// exclude `~` from the punctuation side so that strikethrough delimiters
// are not mistaken for emphasis punctuation.

const RX_PUNCT = /[\p{P}\p{S}]/u;
const RX_PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const RX_NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const RX_PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const RX_PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const RX_NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

// Backslash escape, code span, hard break.
const RX_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RX_CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RX_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

// Any punctuation after a backslash, and the same outside code spans.
const RX_ANY_PUNCT = buildRx(/\\(punct)/, 'gu').replace(/punct/g, RX_PUNCT).regex();
const RX_ANY_PUNCT_OUTSIDE_CODE = buildRx(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  'gu',
)
  .replace(/punct/g, RX_PUNCT)
  .regex();

// Plain text: consume up to the next character that can start an inline
// construct, or up to a position where an extended autolink or a hard
// break can start. The lookaheads keep email-like and URL-like text
// intact so the autolink rules can claim it.
const RX_SCHEME = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const RX_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RX_EMAIL_PROTO = buildRx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, RX_EMAIL)
  .regex();
const RX_INLINE_TEXT = buildRx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .replace('protocol', RX_SCHEME)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .regex();

// Autolinks: <scheme:...> and <email>.
const RX_AUTOLINK = buildRx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace(
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .regex();

// GFM extended autolink: www., scheme://, or a bare email address.
const RX_EXT_URL = buildRx(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
)
  .replace('emailProtocol', RX_EMAIL_PROTO)
  .replace('protocol', RX_SCHEME)
  .replace(
    'email',
    /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  )
  .regex();
// Trims trailing punctuation off an extended autolink, one step at a time.
const RX_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Inline HTML tag: comment, closing tag, open tag, processing
// instruction, declaration, CDATA.
const RX_COMMENT_TAG = buildRx(RX_HTML_COMMENT).replace('(?:-->|$)', '-->').regex();
const RX_TAG = buildRx(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
)
  .replace('comment', RX_COMMENT_TAG)
  .replace(
    'attribute',
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .regex();

// Link label fragments. A bracketed label may nest one level and may
// contain escapes, code spans and balanced brackets; a reference label
// may not contain brackets at all.
const RX_BRACKETED_LABEL = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const RX_LINK_LABEL = buildRx(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
)
  .replace('brackets', RX_BRACKETED_LABEL)
  .regex();
const RX_INLINE_LINK = buildRx(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
)
  .replace('label', RX_LINK_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .regex();
const RX_REF_LINK = buildRx(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', RX_LINK_LABEL)
  .replace('ref', RX_LABEL)
  .regex();
const RX_NOLINK = buildRx(/^!?\[(ref)\](?:\[\])?/).replace('ref', RX_LABEL).regex();

// The search pattern for the emphasis mask: reference-style links, with
// a looser label so that a label containing backticks or brackets still
// matches, and a reference text of up to 999 characters.
const RX_REF_TEXT = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const RX_REF_SEARCH_LABEL = buildRx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .replace('brackets', RX_BRACKETED_LABEL)
  .regex();
const RX_REF_SEARCH = buildRx('reflink|nolink(?!\\()', 'g')
  .replace(
    'reflink',
    buildRx(/^!?\[(label)\]\[(ref)\]/)
      .replace('label', RX_REF_SEARCH_LABEL)
      .replace('ref', RX_REF_TEXT)
      .regex(),
  )
  .replace(
    'nolink',
    buildRx(/^!?\[(ref)\](?:\[\])?/).replace('ref', RX_REF_TEXT).regex(),
  )
  .regex();

// The masking pass hides inline links, code spans and HTML tags from the
// emphasis closer search: a link `[...](...)`, a code span and a tag are
// each replaced by a bracketed run of the same length, so positions in
// the masked copy line up with positions in the original.
const RX_BLOCK_SKIP = buildRx(/link|precode-code|html/, 'g')
  .replace(
    'link',
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .regex();

// Emphasis delimiter rules.
//
// An opener is a run of `*` or `_`, optionally followed by one character
// that decides whether the run can open at all: punctuation or a
// non-space character after the run. The closer search walks the masked
// text with a "right delimiter" pattern whose alternatives classify each
// run it meets: runs that can only open (and so extend the opener),
// runs that can close, and runs that can do either. The first two
// alternatives of each closer pattern are skips: they jump over text and
// over `__...*...` / `**..._...` shapes that can never contain a closer.
const RX_EM_LDELIM_BASE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const RX_EM_LDELIM = buildRx(RX_EM_LDELIM_BASE, 'u')
  .replace(/punct/g, RX_PUNCT_NO_TILDE)
  .regex();
const RX_EM_RDELIM_AST = buildRx(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)',
  'gu',
)
  .replace(/notPunctSpace/g, RX_NOT_PUNCT_SPACE_TILDE)
  .replace(/punctSpace/g, RX_PUNCT_SPACE_NO_TILDE)
  .replace(/punct/g, RX_PUNCT_NO_TILDE)
  .regex();
const RX_EM_RDELIM_UND = buildRx(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
  'gu',
)
  .replace(/notPunctSpace/g, RX_NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, RX_PUNCT_SPACE)
  .replace(/punct/g, RX_PUNCT)
  .regex();

// Strikethrough delimiter rules (GFM `~` and `~~`).
const RX_DEL_LDELIM = buildRx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, RX_PUNCT)
  .regex();
const RX_DEL_RDELIM = buildRx(
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
  'gu',
)
  .replace(/notPunctSpace/g, RX_NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, RX_PUNCT_SPACE)
  .replace(/punct/g, RX_PUNCT)
  .regex();

// A single punctuation-or-space character (never `*` or `_`).
const RX_PUNCT_CHAR = buildRx(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, RX_PUNCT_SPACE)
  .regex();

// The inline rules, in the order the inline pass tries them.
const INLINE = {
  escape: RX_ESCAPE,
  code: RX_CODE_SPAN,
  br: RX_BR,
  text: RX_INLINE_TEXT,
  autolink: RX_AUTOLINK,
  url: RX_EXT_URL,
  tag: RX_TAG,
  link: RX_INLINE_LINK,
  reflink: RX_REF_LINK,
  nolink: RX_NOLINK,
  reflinkSearch: RX_REF_SEARCH,
  blockSkip: RX_BLOCK_SKIP,
  anyPunctuation: RX_ANY_PUNCT,
  anyPunctuationOutsideCode: RX_ANY_PUNCT_OUTSIDE_CODE,
  emStrongLDelim: RX_EM_LDELIM,
  emStrongRDelimAst: RX_EM_RDELIM_AST,
  emStrongRDelimUnd: RX_EM_RDELIM_UND,
  delLDelim: RX_DEL_LDELIM,
  delRDelim: RX_DEL_RDELIM,
  punctuation: RX_PUNCT_CHAR,
  backpedal: RX_BACKPEDAL,
};

// ---------------------------------------------------------------------------
// Small helpers

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML. With `encode`, every & < > " ' is escaped (for
// code spans, where entities are literal); otherwise an `&` that already
// starts a valid entity reference is left alone.
function escapeHtml(text, encode) {
  if (encode) {
    if (RX_ESC_TEST.test(text)) return text.replace(RX_ESC_REPLACE, (ch) => HTML_ESCAPES[ch]);
  } else if (RX_ESC_TEST_NOENC.test(text)) {
    return text.replace(RX_ESC_REPLACE_NOENC, (ch) => HTML_ESCAPES[ch]);
  }
  return text;
}

// Decode numeric character references in plain text. An invalid code
// point becomes U+FFFD; a reference to `&` stays escaped.
function unescapeNumeric(text) {
  return RX_NUM_REF.test(text)
    ? text.replace(RX_NUM_REF_OR_AMP, (whole, dec, hex) => {
        if (dec === undefined && hex === undefined) return '&amp;';
        const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
        if (code === 38) return '&amp;';
        return String.fromCodePoint(code);
      })
    : text;
}

// Clean a link destination the way browsers do: percent-encode it, but
// keep literal `%` characters that were already there.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(RX_PERCENT, '%');
  } catch {
    return null;
  }
}

// Split a table row into cells. A `\|` is an escaped pipe, not a cell
// boundary; leading and trailing empty cells from outer pipes are dropped.
function splitCells(row, count) {
  const marked = row.replace(RX_PIPE_FIND, (ch, at, src) => {
    let escaped = false;
    let i = at;
    while (--i >= 0 && src[i] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(RX_PIPE_SPLIT);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(RX_PIPE_ESC, '|');
  return cells;
}

// Strip trailing copies of one character (or, when `invert` is set,
// trailing characters that are anything but it).
function stripTrailing(text, ch, invert) {
  const n = text.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n; ) {
    const c = text.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return text.slice(0, n - cut);
}

// Drop trailing blank lines from an indented code block, keeping at most
// one trailing newline's worth of blank line.
function stripBlankTail(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && RX_BLANK_LINE.test(lines[last]); ) last--;
  return lines.length - last <= 2 ? text : lines.slice(0, last + 1).join('\n');
}

// Normalize a link label for definition lookup: collapse whitespace and
// fold case, with the lower-upper-lower round trip that keeps certain
// Unicode case mappings stable.
function normalizeLabel(label) {
  return label.trim().replace(RX_MULTI_SPACE_G, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing parenthesis that balances the opens in
// `text`, skipping backslash escapes. Returns -2 when an opener is left
// unclosed, -1 when there is no closer at all.
function findParenClose(text, pair) {
  if (text.indexOf(pair[0]) === -1 && text.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1] && (--depth, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces from a starting column (tab stops of four).
function expandTabs(text, col = 0) {
  let out = '';
  let at = col;
  for (const ch of text) {
    if (ch === '\t') {
      const width = 4 - (at % 4);
      out += ' '.repeat(width);
      at += width;
    } else {
      out += ch;
      at++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis masking
//
// Before a run of inline text is scanned for emphasis, a masked copy is
// made in which link labels, code spans and HTML tags are hidden, so that
// a `*` or `_` inside one of them can never close emphasis that started
// outside. The masked copy keeps the exact length of the original, so
// every index in one is the same position in the other.
//
// `lastClosers` scans a (masked) string for the last delimiter run of
// each kind that could close emphasis: a run whose preceding character
// is not whitespace. The scan is cached per inline run on a stack, so
// nested inline scans (link labels, emphasis contents) each see their
// own copy.
function lastClosers(src) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const before = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < n && src[j] === ch) j++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm: em, lastDel: del };
}

// Build a link or image token from a matched link. The label's inline
// content is parsed recursively; a link whose label itself contains a
// link is not a link at all (CommonMark forbids nested links).
function makeLink(match, dest, raw, lexer) {
  const href = dest.href;
  const title = dest.title || null;
  const label = match[1].replace(RX_LINK_BRACKET_ESC, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const inner = lexer.inlineTokens(label);
  const innerHadLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (innerHadLink) {
      lexer.state.inRawBlock = savedRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text: label, tokens: inner };
}

// Remove the fence's own indent from each line of fenced code.
function fenceIndent(raw, code) {
  const m = raw.match(RX_FENCE_INDENT);
  if (m === null) return code;
  const indent = m[1];
  return code
    .split('\n')
    .map((line) => {
      const lead = line.match(RX_LEAD_SPACE);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// Does the link label contain a `<...>` that is really an HTML tag or an
// autolink reaching past the end of the label? If so, the bracketed text
// is not a link.
function hasTagBefore(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tokenizer: turns source text into tokens, one block or inline construct
// at a time. It holds a reference to the lexer that owns it, for the
// shared parse state and the inline queue.

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
    // Stack of masking results, one per open inline scan.
    this.masks = [];
  }

  // -- block constructs ---------------------------------------------------

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return undefined;
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = stripBlankTail(m[0]);
      return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RX_CODE_INDENT, '') };
    }
    return undefined;
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      return {
        type: 'code',
        raw: m[0],
        lang: m[2] ? m[2].trim().replace(RX_ANY_PUNCT, '$1') : m[2],
        text: fenceIndent(m[0], m[3] || ''),
      };
    }
    return undefined;
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (RX_END_HASH.test(text)) {
        const stripped = stripTrailing(text, '#');
        if (!stripped || RX_END_SPACE_TAB.test(stripped)) text = stripped.trim();
      }
      return {
        type: 'heading',
        raw: stripTrailing(m[0], '\n'),
        depth: m[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: stripTrailing(m[0], '\n') };
    return undefined;
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    const lines = stripTrailing(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let seenMarker = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (RX_BQ_START.test(lines[p])) {
          chunk.push(lines[p]);
          seenMarker = true;
        } else if (!seenMarker) {
          chunk.push(lines[p]);
        } else {
          break;
        }
      }
      lines.splice(0, p);
      const joined = chunk.join('\n');
      // Strip the `>` markers, expanding a tab after the marker against
      // the marker's column, and protect setext underlines inside the
      // quote from being read as headings of the outer text.
      const stripped = joined
        .replace(RX_BQ_MARKER_WS, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(RX_BQ_SETEXT, '\n    $1')
        .replace(RX_BQ_SETEXT2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${stripped}` : stripped;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (
        last &&
        (last.type === 'code' ||
          last.type === 'heading' ||
          last.type === 'hr' ||
          last.type === 'html' ||
          last.type === 'table')
      ) {
        break;
      }
      if (last && last.type === 'blockquote') {
        // A nested quote: re-parse it together with the lines that
        // follow, and keep whichever of those lines it consumed.
        const inner = last;
        const rest = lines.join('\n');
        const combined = inner.raw + '\n' + rest.replace(RX_BQ_SETEXT2, '');
        const reparsed = this.blockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const leftover = combined.substring(reparsed.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const taken = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
        text = text.substring(0, text.length - inner.text.length) + reparsed.text;
        lines.splice(0, taken.length);
        if (lines.length > 0 && RX_BQ_START.test(lines[0])) continue;
        break;
      } else if (last && last.type === 'list') {
        // A list at the end of the quote: re-parse it together with the
        // lines that follow, and keep whichever of those it consumed.
        const inner = last;
        const combined = inner.raw + '\n' + lines.join('\n');
        const reparsed = this.list(combined);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > inner.raw.length
            ? combined.slice(inner.raw.length + 1, reparsed.raw.length).split('\n').length
            : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${taken}`;
          text = `${text}\n${taken}`;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const first = BLOCK.list.exec(src);
    if (!first) return undefined;
    const whole = src;
    const consumed = () => whole.length - src.length;
    let bullet = first[1].trim();
    const ordered = bullet.length > 1;
    const listTok = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRe(bullet);
    let sawBlank = false;
    while (src) {
      let emptyFirst = false;
      let content = '';
      const match = itemRe.exec(src);
      if (!match || BLOCK.hr.test(src)) break;
      const startPos = consumed();
      src = src.substring(match[0].length);
      const firstLine = match[2].split('\n', 1)[0];
      const bulletLen = match[1].length;
      let marker = firstLine.replace(RX_LEAD_SPACE_TAB, (ws) => expandTabs(ws, bulletLen));
      let nextLine = src.split('\n', 1)[0];
      let firstEmpty = !marker.trim();
      let indent;
      if (firstEmpty) {
        indent = bulletLen + 1;
      } else {
        indent = marker.search(RX_NON_SPACE);
        if (indent > 4) indent = 1;
        content = marker.slice(indent);
        indent += bulletLen;
      }
      if (firstEmpty && RX_BLANK_LINE.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        emptyFirst = true;
      }
      if (!emptyFirst) {
        const nextBullet = nextBulletAt(indent);
        const hrHere = hrAt(indent);
        const fenceHere = fencesBeginAt(indent);
        const headingHere = headingBeginAt(indent);
        const htmlHere = htmlBeginAt(indent);
        const bqHere = blockquoteBeginAt(indent);
        while (src) {
          const nl = src.indexOf('\n');
          const line = nl === -1 ? src : src.slice(0, nl);
          // Scan the leading whitespace once: it gives the tab-expanded
          // form, the first non-space position, and the first character
          // that could start a block which interrupts the list item.
          // Only that character's rule can match, so the other five
          // interruption tests are skipped outright.
          let leadEnd = 0;
          let hasTab = false;
          while (leadEnd < line.length) {
            const c = line[leadEnd];
            if (c === ' ') leadEnd++;
            else if (c === '\t') {
              leadEnd++;
              hasTab = true;
            } else break;
          }
          const expandedLead = hasTab ? expandTabs(line.slice(0, leadEnd)) : '';
          const expanded = hasTab ? expandedLead + line.slice(leadEnd) : line;
          let sp = 0;
          while (sp < line.length && line[sp] === ' ') sp++;
          const head = sp < line.length && line[sp] !== '\t' && sp <= indent ? line[sp] : '';
          let interrupts = false;
          if (head === '`' || head === '~') interrupts = fenceHere.test(line);
          else if (head === '#') interrupts = headingHere.test(line);
          else if (head === '<') interrupts = htmlHere.test(line);
          else if (head === '>') interrupts = bqHere.test(line);
          else if (head === '*') interrupts = nextBullet.test(line) || hrHere.test(line);
          else if (head === '+') interrupts = nextBullet.test(line);
          else if (head === '-') interrupts = nextBullet.test(line) || hrHere.test(line);
          else if (head >= '0' && head <= '9') interrupts = nextBullet.test(line);
          else if (head === '_') interrupts = hrHere.test(line);
          if (interrupts) break;
          const firstNonSpace =
            leadEnd === line.length ? -1 : hasTab ? expandedLead.length : leadEnd;
          const isBlank = !line.trim();
          if (firstNonSpace >= indent || isBlank) {
            content += '\n' + expanded.slice(indent);
          } else {
            if (
              firstEmpty ||
              marker.replace(RX_TAB_G, '    ').search(RX_NON_SPACE) >= 4 ||
              fenceHere.test(marker) ||
              headingHere.test(marker) ||
              htmlHere.test(marker) ||
              hrHere.test(marker)
            ) {
              break;
            }
            const setextLike =
              /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${marker}\n${line}`);
            content += '\n' + (setextLike ? `    ${expanded.replace(/^ {0,3}/, '')}` : line);
          }
          firstEmpty = isBlank;
          src = nl === -1 ? '' : src.substring(nl + 1);
          marker = expanded.slice(indent);
        }
      }
      const itemRaw = whole.slice(startPos, consumed());
      if (!listTok.loose) {
        if (sawBlank) listTok.loose = true;
        else if (RX_DOUBLE_BLANK.test(itemRaw)) sawBlank = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: RX_LIST_TASK.test(content),
        loose: false,
        text: content,
        tokens: [],
      });
    }
    const lastItem = listTok.items[listTok.items.length - 1];
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return undefined;
    }
    listTok.raw = whole.slice(0, consumed()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => RX_ANY_LINE.test(t.raw))) listTok.loose = true;
      }
    }
    for (const item of listTok.items) {
      const firstTok = item.tokens[0];
      if (item.task && firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
        item.text = item.text.replace(RX_LIST_TASK_STRIP, '');
        firstTok.raw = firstTok.raw.replace(RX_LIST_TASK_STRIP, '');
        firstTok.text = firstTok.text.replace(RX_LIST_TASK_STRIP, '');
        for (let q = this.lexer.inlineQueue.length - 1; q >= 0; q--) {
          if (RX_LIST_TASK.test(this.lexer.inlineQueue[q].src)) {
            this.lexer.inlineQueue[q].src = this.lexer.inlineQueue[q].src.replace(
              RX_LIST_TASK_STRIP,
              '',
            );
            break;
          }
        }
        const box = RX_TASK_BOX.exec(item.raw);
        if (box) {
          const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (listTok.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkbox.raw,
                text: checkbox.raw,
                tokens: [checkbox],
              });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listTok;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = stripBlankTail(m[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      };
    }
    return undefined;
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (m) {
      if (!RX_START_ANGLE.test(m[2]) && findParenClose(m[2], '()') !== -1) return undefined;
      const tag = normalizeLabel(m[1]);
      const href = m[2] ? m[2].replace(RX_HREF_BRACKETS, '$1').replace(RX_ANY_PUNCT, '$1') : '';
      const title = m[3]
        ? m[3].substring(1, m[3].length - 1).replace(RX_ANY_PUNCT, '$1')
        : m[3];
      return { type: 'def', tag, raw: stripTrailing(m[0], '\n'), href, title };
    }
    return undefined;
  }

  table(src) {
    // The delimiter row is the second line and always contains a `-`;
    // without one in that line there is no table to match.
    const nl1 = src.indexOf('\n');
    if (nl1 === -1) return undefined;
    const nl2 = src.indexOf('\n', nl1 + 1);
    const line2End = nl2 === -1 ? src.length : nl2;
    const dash = src.indexOf('-', nl1 + 1);
    if (dash === -1 || dash >= line2End) return undefined;
    const m = BLOCK.table.exec(src);
    if (!m || !RX_TABLE_DELIM.test(m[2])) return undefined;
    const headerCells = splitCells(m[1]);
    const alignParts = m[2].replace(RX_TABLE_ALIGN_TRIM, '').split('|');
    const bodyLines =
      m[3] && m[3].trim() ? m[3].replace(RX_TABLE_ROW_BLANK, '').split('\n') : [];
    const tok = { type: 'table', raw: stripTrailing(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === alignParts.length) {
      for (const part of alignParts) {
        if (RX_ALIGN_RIGHT.test(part)) tok.align.push('right');
        else if (RX_ALIGN_CENTER.test(part)) tok.align.push('center');
        else if (RX_ALIGN_LEFT.test(part)) tok.align.push('left');
        else tok.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        tok.header.push({
          text: headerCells[i],
          tokens: this.lexer.inline(headerCells[i]),
          header: true,
          align: tok.align[i],
        });
      }
      for (const line of bodyLines) {
        tok.rows.push(
          splitCells(line, tok.header.length).map((cell, i) => ({
            text: cell,
            tokens: this.lexer.inline(cell),
            header: false,
            align: tok.align[i],
          })),
        );
      }
      return tok;
    }
    return undefined;
  }

  lheading(src) {
    // A setext underline is a line of `=` or `-` before the first blank
    // line; without one in that window there is no heading to match.
    const blankAt = src.search(/\n[ \t]*\n/);
    const window = blankAt === -1 ? src : src.slice(0, blankAt);
    if (!/\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/.test(window)) return undefined;
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: 'heading',
        raw: stripTrailing(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (m) {
      const text =
        m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
    return undefined;
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (m) {
      return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
    }
    return undefined;
  }

  // -- inline constructs --------------------------------------------------

  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
    return undefined;
  }

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (m) {
      if (!this.lexer.state.inLink && RX_START_A_TAG.test(m[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && RX_END_A_TAG.test(m[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && RX_START_PRE_TAG.test(m[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && RX_END_PRE_TAG.test(m[0])) {
        this.lexer.state.inRawBlock = false;
      }
      return {
        type: 'html',
        raw: m[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: m[0],
      };
    }
    return undefined;
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(src);
    if (!m) return undefined;
    const labelOffset = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasTagBefore(src, m[1], labelOffset)) return undefined;
    let dest = m[2].trim();
    if (RX_START_ANGLE.test(dest)) {
      if (!RX_END_ANGLE.test(dest)) return undefined;
      const stripped = stripTrailing(dest.slice(0, -1), '\\');
      if ((dest.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const close = findParenClose(m[2], '()');
      if (close === -2) return undefined;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const tailStripped = stripTrailing(m[0].slice(0, -1), '\\');
    if ((m[0].length - tailStripped.length) % 2 === 0) return undefined;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (RX_START_ANGLE.test(href)) href = href.slice(1, -1);
    return makeLink(
      m,
      {
        href: href && href.replace(RX_ANY_PUNCT, '$1'),
        title: title && title.replace(RX_ANY_PUNCT, '$1'),
      },
      m[0],
      this.lexer,
    );
  }

  reflink(src, links) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return undefined;
    const labelOffset = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasTagBefore(src, m[1], labelOffset)) return undefined;
    const def = links[normalizeLabel(m[2] || m[1])];
    if (!def) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLink(m, def, m[0], this.lexer);
  }

  // Emphasis and strong emphasis, by delimiter runs. `src` is the text
  // still to scan, `masked` is the masked copy of the whole inline run
  // (same length as the run's original text), and `prev` is the last
  // character of the text token just before this one, or ''.
  //
  // The opener is the run at the start of `src`. The closer search walks
  // the masked text after the opener with the right-delimiter pattern,
  // which classifies each run it meets: runs that can only open are added
  // to the opener's length, runs that can close are candidates, and the
  // rule of three keeps a closer from matching an opener when their
  // lengths sum to a multiple of three but neither alone does. The first
  // closer that consumes the whole opener wins; whether it makes `em` or
  // `strong` depends on the parity of the shorter of the two runs.
  emStrong(src, masked, prev = '') {
    const open = INLINE.emStrongLDelim.exec(src);
    if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return undefined;
    const delim = open[0][0];
    const sameAsPrev = prev === delim;
    const offset = masked.length - src.length;
    let runStart = offset;
    while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
    const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunctOrDelim =
      beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    if (runStart < offset) prev = beforeRun;
    const prevIsPunct = runStart < offset ? beforeIsPunctOrDelim : !!INLINE.punctuation.exec(prev);
    if (open[4] && prev.match(RX_ALNUM)) return undefined;
    const punctAfter = open[1] || open[3] || '';
    if (!punctAfter || !prev || prevIsPunct) {
      const k = [...open[0]].length - 1;
      let g;
      let b;
      let m = k;
      let f = 0;
      const y = offset - runStart + k;
      const canAlsoClose =
        !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsPunctOrDelim));
      if (delim !== '*' && delim !== '_') return undefined;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lastEm(masked, delim);
      const afterOpener = masked.length - src.length + k;
      if (lastCloser < afterOpener) return undefined;
      const scan = masked.slice(k - src.length);
      const limit = lastCloser - afterOpener;
      for (closerRe.lastIndex = 0; ; ) {
        const s = closerRe.exec(scan);
        if (s === null || s.index > limit) break;
        g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
        if (!g) continue;
        b = [...g].length;
        if (s[3] || s[4]) {
          m += b;
          continue;
        } else if (s[5] || s[6] || canAlsoClose) {
          if (sameAsPrev && (s[5] || s[6])) break;
          if (y % 3 && !((y + b) % 3)) {
            f += b;
            continue;
          }
        }
        m -= b;
        if (m > 0) continue;
        b = Math.min(b, b + m + f);
        const leadLen = [...s[0]][0].length;
        const whole = src.slice(0, k + s.index + leadLen + b);
        if (Math.min(k, b) % 2) {
          const inner = whole.slice(1, -1);
          return { type: 'em', raw: whole, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = whole.slice(2, -2);
        return { type: 'strong', raw: whole, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(RX_NEWLINE_G, ' ');
      const hasNonSpace = RX_NON_SPACE.test(text);
      const wrapped = RX_START_SPACE.test(text) && RX_END_SPACE.test(text);
      if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
    return undefined;
  }

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
    return undefined;
  }

  // Strikethrough, by the same delimiter-run idea as emphasis, except a
  // closer must be exactly as long as the opener.
  del(src, masked, prev = '') {
    const open = INLINE.delLDelim.exec(src);
    if (!open) return undefined;
    if (!(open[1] || '') || !prev || INLINE.punctuation.exec(prev)) {
      const k = [...open[0]].length - 1;
      let g;
      let l;
      let m = k;
      const closerRe = INLINE.delRDelim;
      const lastCloser = this.lastDel(masked);
      const afterOpener = masked.length - src.length + k;
      if (lastCloser < afterOpener) return undefined;
      const scan = masked.slice(k - src.length);
      const limit = lastCloser - afterOpener;
      for (closerRe.lastIndex = 0; ; ) {
        const s = closerRe.exec(scan);
        if (s === null || s.index > limit) break;
        g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
        if (!g) continue;
        l = [...g].length;
        if (l !== k) continue;
        if (s[3] || s[4]) {
          m += l;
          continue;
        }
        m -= l;
        if (m > 0) continue;
        l = Math.min(l, l + m);
        const leadLen = [...s[0]][0].length;
        const whole = src.slice(0, k + s.index + leadLen + l);
        const inner = whole.slice(k, -k);
        return { type: 'del', raw: whole, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[1];
        href = 'mailto:' + text;
      } else {
        text = m[1];
        href = text;
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
    return undefined;
  }

  url(src) {
    const m = INLINE.url.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let prev;
        do {
          prev = m[0];
          m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? '';
        } while (prev !== m[0]);
        text = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
    return undefined;
  }

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeNumeric(m[0]), escaped: inRaw };
    }
    return undefined;
  }

  // The last delimiter run in the masked copy that could close emphasis
  // (or strikethrough), from the cache of the open inline scan when it
  // covers this copy, or computed fresh.
  lastEm(masked, delim) {
    const top = this.masks[this.masks.length - 1];
    if (top && top.maskedSrc === masked) return top.lastEm[delim];
    return lastClosers(masked).lastEm[delim];
  }

  lastDel(masked) {
    const top = this.masks[this.masks.length - 1];
    if (top && top.maskedSrc === masked) return top.lastDel;
    return lastClosers(masked).lastDel;
  }
}

// ---------------------------------------------------------------------------
// Lexer: runs the block pass over a document, then the inline pass over
// every queued piece of text. Link reference definitions are collected
// during the block pass, so the inline pass — which runs only after the
// whole document has been block-parsed — can use definitions that appear
// later in the file.

class Lexer {
  constructor() {
    this.tokens = [];
    this.links = Object.create(null);
    this.linkCount = 0;
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
    this.inlineQueue = [];
    this.tokenizer = new Tokenizer(this);
  }

  lex(src) {
    src = src.replace(RX_CR, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue a piece of text for inline parsing; the returned array is
  // filled in by lex() once the block pass is done.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, tokens = [], inBlockquote = false) {
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.fences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.heading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.hr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.blockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.list(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.html(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          if (!this.links[tok.tag]) {
            this.links[tok.tag] = { href: tok.href, title: tok.title };
            this.linkCount++;
          }
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.table(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.lheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        const last = tokens[tokens.length - 1];
        if (inBlockquote && last && last.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        inBlockquote = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  // Does `src` contain a link (inline or reference) that would be
  // claimed before any emphasis inside it? Used by the masking pass to
  // decide whether a reference link's label needs recursive masking.
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (
        !(s.charAt(0) === '!' || !Object.hasOwn(this.links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && this.linkInText(s.slice(1, r - 1)))
      ) {
        return true;
      }
    }
    return false;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.scanInline(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  // The masking pass (see the header comment): hide reference links,
  // backslash punctuation, code spans and HTML tags from the emphasis
  // closer search, then scan. When the text holds none of the characters
  // that can start one of those constructs, every replacement below is
  // the identity and the original text is already the masked copy.
  maskForEmphasis(src) {
    if (
      !src.includes('[') &&
      !src.includes('`') &&
      !src.includes('<') &&
      !src.includes('\\')
    ) {
      return src;
    }
    let out = src;
    if (this.linkCount > 0 && src.includes('[')) {
      const maskRef = (match) => {
        const open = match.lastIndexOf('[');
        if (!Object.hasOwn(this.links, normalizeLabel(match.slice(open + 1, -1)))) {
          return match;
        }
        if (open > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, open - 1);
          if (this.linkInText(inner)) {
            return (
              '[' +
              inner.replace(INLINE.reflinkSearch, maskRef) +
              '][' +
              'a'.repeat(match.length - open - 2) +
              ']'
            );
          }
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      out = out.replace(INLINE.reflinkSearch, maskRef);
    }
    out = out.replace(INLINE.anyPunctuationOutsideCode, (whole, ticks, punct) =>
      punct
        ? '+'.repeat(whole.length)
        : ticks
          ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
          : whole,
    );
    out = out.replace(INLINE.blockSkip, (whole, _backticks, prefix) => {
      const keep = prefix ? prefix.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
    return out;
  }

  scanInline(src, tokens) {
    const masked =
      src.includes('*') || src.includes('_') || src.includes('~')
        ? this.maskForEmphasis(src)
        : src;
    this.tokenizer.masks.push(lastClosers(masked));
    try {
      return this.scanInlineLoop(src, masked, tokens);
    } finally {
      this.tokenizer.masks.pop();
    }
  }

  scanInlineLoop(src, masked, tokens) {
    let wasText = false;
    let prevChar = '';
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!wasText) prevChar = '';
      wasText = false;
      let tok;
      if ((tok = this.tokenizer.escape(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.tag(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.link(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.reflink(src, this.links))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.type === 'text' && last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.emStrong(src, masked, prevChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.codespan(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.br(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.del(src, masked, prevChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.autolink(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!this.state.inLink && (tok = this.tokenizer.url(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        wasText = true;
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Rendering: tokens to HTML strings. `renderInlineText` is the plain-text
// renderer used for image alt text, where markup collapses to its words.

function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return renderInlineHtml(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderInlineHtml(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += renderTextToken(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
        out += renderLink(tok);
        break;
      case 'image':
        out += renderImage(tok);
        break;
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'strong':
        out += `<strong>${renderInlineHtml(tok.tokens)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderInlineHtml(tok.tokens)}</em>`;
        break;
      case 'codespan':
        out += `<code>${escapeHtml(tok.text, true)}</code>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += `<del>${renderInlineHtml(tok.tokens)}</del>`;
        break;
      case 'text':
        out += renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderInlineText(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += tok.tokens ? renderInlineText(tok.tokens) : tok.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderLink(tok) {
  const inner = tok.autolink ? escapeHtml(tok.text, true) : renderInlineHtml(tok.tokens);
  const cleaned = cleanUrl(tok.href);
  if (cleaned === null) return inner;
  const href = escapeHtml(cleaned, tok.autolink);
  let out = `<a href="${href}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + `>${inner}</a>`;
}

function renderImage(tok) {
  let alt = tok.text;
  if (tok.tokens) alt = renderInlineText(tok.tokens);
  const cleaned = cleanUrl(tok.href);
  if (cleaned === null) return escapeHtml(alt);
  let out = `<img src="${escapeHtml(cleaned)}" alt="${escapeHtml(alt)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + '>';
}

function renderCode(tok) {
  const lang = (tok.lang || '').match(RX_NOT_SPACE_START)?.[0];
  const body = tok.text ? tok.text.replace(RX_END_NEWLINE, '') + '\n' : '';
  const inner = tok.escaped ? body : escapeHtml(body, true);
  return lang
    ? `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>\n`
    : `<pre><code>${inner}</code></pre>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInlineHtml(cell.tokens) + `</${tag}>\n`;
}

function renderTable(tok) {
  let head = '';
  for (const cell of tok.header) head += renderTableCell(cell);
  const headRow = `<tr>\n${head}</tr>\n`;
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInlineHtml(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case 'code':
        out += renderCode(tok);
        break;
      case 'table':
        out += renderTable(tok);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph':
        out += `<p>${renderInlineHtml(tok.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The entry point: render one markdown document to HTML.

export function parse(markdown) {
  if (markdown === undefined || markdown === null) {
    throw new Error(
      'marked(): input parameter is undefined or null\nPlease report this to https://github.com/markedjs/marked.',
    );
  }
  if (typeof markdown !== 'string') {
    throw new Error(
      `marked(): input parameter is of type ${Object.prototype.toString.call(markdown)}, string expected\nPlease report this to https://github.com/markedjs/marked.`,
    );
  }
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderBlocks(tokens);
}
