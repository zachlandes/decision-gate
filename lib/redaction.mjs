import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { RedactionError } from "./errors.mjs";

// Adapted from herdr-find 4736dd5 (Apache-2.0)

// Redaction for everything a caller sends, in two layers: secret shapes built in here,
// then the user's own value list (names, customer ids, domains no pattern can know). A fail-closed
// sweep follows: a request in which any forbidden pattern survives is never sent. No rule, pattern
// or match is ever printed; a report names rule classes and counts, nothing else.
//
// The optional value list format:
//
//   { "rules": [[class, pattern, replacement], ...], "forbidden": [pattern, ...] }
//
// Patterns are Python-flavoured regular expressions; a leading inline flag group such as (?i)
// becomes a JavaScript flag. Replacements use Python's \1 and \g<name> group syntax.

// A secret word as a whole segment of a key, split by _ or - or a case change, so SECRET_KEY_BASE,
// apiKey, DBPassword and password_confirmation qualify and tokens, monkey and keyboard do not
const SECRET_SEGMENT = String.raw`(?:(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|apikey|key)(?![a-z])|(?:Password|Passwd|Pwd|Secret|Token|Apikey|Key)(?![a-z])|(?<![A-Za-z0-9])(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|APIKEY|KEY)(?![A-Za-z]))`;

const SECRET_PAIR = new RegExp(String.raw`(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?![A-Za-z0-9_-])(?<=${SECRET_SEGMENT}[A-Za-z0-9_-]*)["']?\s*(?:===|!==|==|!=|=>|:=|=|:(?!:))\s*`, "g");
const QUOTES = "\"'`";
const CLOSES = { ")": "(", "]": "[", "}": "{" };

// Plainly code: a bare identifier with no digits, a $VAR or ${VAR} reference, member access or
// indexing, or a call. Keyword-led expressions such as await x or new X() stop at the space and
// arrive here as a bare identifier
const PLAINLY_CODE = /^(?:[A-Za-z_]+|\$\{*\s*[A-Za-z_]*\s*\}*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])+|[^(]*\(.*)$/;

// Brackets and quotes left open earlier on the current line, which a value may close; read once
// per line as the scan moves forward
function lineContext(text) {
  let at = 0;
  let open = [];
  let quotes = new Set();
  return (to) => {
    for (; at < to; at += 1) {
      const c = text[at];
      if (c === "\n") { open = []; quotes = new Set(); }
      else if (QUOTES.includes(c)) quotes.has(c) ? quotes.delete(c) : quotes.add(c);
      else if ("([{".includes(c)) open.push(c);
      else if (c in CLOSES && open.at(-1) === CLOSES[c]) open.pop();
    }
    return { open, quotes };
  };
}

// The value of a key that names a secret is redacted unless it is plainly code. A quoted value
// runs to its closing quote, honouring escapes, or to the end of the line. A bare value ends at
// whitespace, a comma, or a quote or bracket that closes one opened earlier on the line; a stray
// quote or bracket stays inside it
function redactPairs(text, counted) {
  let out = "";
  let last = 0;
  const context = lineContext(text);
  SECRET_PAIR.lastIndex = 0;
  for (let match; (match = SECRET_PAIR.exec(text));) {
    const start = match.index + match[0].length;
    const lineEnd = text.indexOf("\n", start) === -1 ? text.length : text.indexOf("\n", start);
    let end = start;
    let value;
    if (QUOTES.includes(text[start])) {
      const quote = text[start];
      end += 1;
      while (end < lineEnd && text[end] !== quote) end += text[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, lineEnd);
      value = `${quote}[redacted]${quote}`;
    } else {
      const before = context(start);
      const inner = [];
      for (; end < lineEnd; end += 1) {
        const c = text[end];
        if (/\s/.test(c) || c === ",") break;
        if (QUOTES.includes(c) && before.quotes.has(c)) break;
        if ("([{".includes(c)) inner.push(c);
        else if (c in CLOSES) {
          if (inner.at(-1) === CLOSES[c]) inner.pop();
          else if (before.open.includes(CLOSES[c])) break;
        }
      }
      const bare = text.slice(start, end).replace(/;+$/, "");
      value = !bare || PLAINLY_CODE.test(bare) ? text.slice(start, end) : `[redacted]${text.slice(start + bare.length, end)}`;
    }
    if (value !== text.slice(start, end)) counted();
    out += text.slice(last, start) + value;
    last = end;
    SECRET_PAIR.lastIndex = Math.max(end, start);
  }
  return out + text.slice(last);
}

// Known secret formats only, applied before the user's rules to whole texts. A secret in no listed
// format and not on the user's list is sent; guessing at random-looking strings erased file paths.
export const BUILT_IN_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, "[private key]"],
  // Runs before the prefixed formats so a variable holding one loses its whole value
  ["secret-pair", redactPairs],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[token]"],
  ["bearer", /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [token]"],
  ["authorization", /\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:basic|bearer|token)\s+)?\S+/gi, "$1[redacted]"],
  // OpenAI and Anthropic: a known label with any base64url body, or any body with a capital and a
  // digit; kebab-case names such as sk-learn-model-v2.py are lowercase and pass
  ["api-key", /\bsk-(?:(?:proj|svcacct|admin|None|ant-[a-z]+[0-9]*)-[A-Za-z0-9_-]{20,}|(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,})/g, "[api key]"],
  ["api-key", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[api key]"],
  ["github-token", /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[github token]"],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g, "[gitlab token]"],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}/g, "[npm token]"],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[slack token]"],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[aws key]"],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}/g, "[google key]"],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[redacted]@"],
  // Pixel-density image names such as logo@2x.png are not addresses
  ["email", /\b[A-Za-z0-9._%+-]+@(?![0-9]+(?:\.[0-9]+)?[xX]\.(?:[pP][nN][gG]|[jJ][pP][eE]?[gG]|[gG][iI][fF]|[wW][eE][bB][pP]|[sS][vV][gG]|[aA][vV][iI][fF])\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "[email]"]
];

// A private key piped in as several lines, judged by the key text at the end of each line so any
// prefix (rg paths, diff markers, line numbers, or a quote opening a multi-line value) is ignored
// and kept. A block opens on a line whose last text is the BEGIN marker, so a one-line string
// constant holding the marker never opens one. It runs while lines end with key body, to a line
// holding the END marker, whatever code closes the value after it, or, when the key was cut off,
// to the first line that is not body
const BEGIN_AT_END = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\s*$/;
const END_AT_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*$/;
const HEADER_AT_END = /(?<![A-Za-z-])(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset): [^\n]*$/;
const BODY_AT_END = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{40,}\s*$/;
// A blank line, perhaps under a prefix such as rg's path:3: or cat -n's number, as PGP armour has
const BLANK_AT_END = /(?:^|[:-]\d+[:-]|^\s*\d+|^[+-])\s*$/;
// The last body line and a PGP checksum line are short; they count only in a short run ending at END
const TAIL_AT_END = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]+\s*$/;

// A PGP block ends with the last short body line, then its checksum line, then END
function tailBeforeEnd(lines, i) {
  for (let j = i + 1; j < lines.length && j <= i + 3; j += 1) {
    if (END_AT_END.test(lines[j])) return true;
    if (!TAIL_AT_END.test(lines[j])) return false;
  }
  return false;
}

function keyText(line, match) {
  if (!match) return undefined;
  // A diff's leading + is a prefix, although + is also a base64 character
  const at = match.index === 0 && line[0] === "+" ? 1 : match.index;
  return `${line.slice(0, at)}[private key]`;
}

// Maps each line of a piped key block to its redacted form
export function privateKeyLines(lines) {
  const redacted = new Map();
  let open = false;
  lines.forEach((line, i) => {
    if (open) {
      const end = line.match(END_AT_END);
      const body = line.match(HEADER_AT_END) ?? line.match(BODY_AT_END)
        ?? (tailBeforeEnd(lines, i) ? line.match(TAIL_AT_END) : null);
      if (end || body) {
        redacted.set(line, keyText(line, end ?? body));
        open = !end;
        return;
      }
      if (BLANK_AT_END.test(line)) return;
    }
    const begin = line.match(BEGIN_AT_END);
    open = Boolean(begin);
    if (begin) redacted.set(line, keyText(line, begin));
  });
  return redacted;
}

// Shapes that must never survive redaction, whatever the user's list says
export const BUILT_IN_FORBIDDEN = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bsk-(?:(?:proj|svcacct|admin|None|ant-[a-z]+[0-9]*)-[A-Za-z0-9_-]{20,}|(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,})/,
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /\bAIza[0-9A-Za-z_-]{35}/
];

function compile(pattern, extra = "") {
  if (typeof pattern !== "string") throw new RedactionError("redaction patterns must be strings");
  const match = pattern.match(/^\(\?([aimsux]+)\)/);
  const flags = new Set(extra);
  let source = pattern;
  if (match) {
    source = pattern.slice(match[0].length);
    for (const flag of match[1]) {
      if (flag === "i" || flag === "m" || flag === "s") flags.add(flag);
      else if (flag !== "u" && flag !== "a") throw new RedactionError("a redaction pattern uses an unsupported inline flag");
    }
  }
  // Unicode mode where the pattern allows it, since Python matches by code point; a pattern with
  // an escape unicode mode rejects (such as \-) compiles without it
  for (const mode of ["u", ""]) {
    try {
      return new RegExp(source, [...flags].join("") + mode);
    } catch { /* try the next mode */ }
  }
  // The pattern itself is private, so the error does not quote it
  throw new RedactionError("a redaction pattern does not compile as a JavaScript regular expression");
}

// Python's replacement syntax: \1, \g<1> and \g<name> insert a group, \\ a backslash; nothing
// else is special, and a JavaScript $ stays literal
function expand(replacement, match) {
  const named = typeof match[match.length - 1] === "object" ? match[match.length - 1] : {};
  return replacement.replace(/\\(?:g<(\w+)>|(\d{1,2})|(\\))/g, (_all, name, number, slash) => {
    if (slash) return "\\";
    const key = name ?? number;
    const value = /^\d+$/.test(key) ? match[Number(key)] : named?.[key];
    return value ?? "";
  });
}

export function createRedactor(spec = { rules: [], forbidden: [] }) {
  if (!spec || !Array.isArray(spec.rules) || !Array.isArray(spec.forbidden)) throw new RedactionError("the redaction file must hold rules and forbidden arrays");
  const rules = spec.rules.map((rule, index) => {
    if (!Array.isArray(rule) || rule.length !== 3 || rule.some((part) => typeof part !== "string")) throw new RedactionError(`redaction rule ${index + 1} must be [class, pattern, replacement]`);
    return { cls: rule[0], pattern: compile(rule[1], "g"), replacement: rule[2] };
  });
  const forbidden = [...BUILT_IN_FORBIDDEN, ...spec.forbidden.map((pattern) => compile(pattern))];
  const counts = Object.create(null);
  const count = (cls) => { counts[cls] = (counts[cls] ?? 0) + 1; };
  const redact = (text) => {
    let out = text;
    for (const [cls, pattern, replacement] of BUILT_IN_RULES) {
      if (typeof pattern === "function") { out = pattern(out, () => count(cls)); continue; }
      out = out.replace(pattern, (...match) => { count(cls); return replacement.replace(/\$(\d)/g, (_all, n) => match[Number(n)] ?? ""); });
    }
    for (const rule of rules) {
      out = out.replace(rule.pattern, (...match) => { count(rule.cls); return expand(rule.replacement, match); });
    }
    return out;
  };
  const allowed = (text) => forbidden.every((pattern) => !pattern.test(text));
  // True when nothing forbidden survives and every built-in rule is already applied. Rule
  // fixpoints only hold for decoded text: on serialized JSON a placeholder such as
  // "authorization: [redacted]" runs into the next field and would never look redacted
  const clean = (text) => allowed(text) && BUILT_IN_RULES.every(([, pattern, replacement]) => {
    if (typeof pattern === "function") return pattern(text, () => {}) === text;
    pattern.lastIndex = 0;
    return text.replace(pattern, replacement) === text;
  });
  return {
    redact,
    allowed,
    clean,
    // The fail-closed check on a serialized request: every decoded key and string must be clean,
    // and the exact bytes must hold nothing forbidden
    check(body) {
      const decoded = (value) => {
        if (typeof value === "string") return clean(value);
        if (value === null || typeof value !== "object") return true;
        return Object.entries(value).every(([key, child]) => clean(key) && decoded(child));
      };
      let request;
      try { request = JSON.parse(body); }
      catch { throw new RedactionError("request must serialize as JSON; nothing was sent"); }
      if (!decoded(request) || !allowed(body)) throw new RedactionError("never-send check refused a request; nothing was sent");
    },
    fingerprint: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    counts: () => ({ ...counts }),
    size: { rules: BUILT_IN_RULES.length + rules.length, forbidden: forbidden.length }
  };
}

export function loadRedactor(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new RedactionError("cannot read the configured redaction file");
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new RedactionError("the redaction file must be a private regular file (chmod 600)");
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RedactionError("the redaction file is not valid JSON");
  }
  return createRedactor(spec);
}
