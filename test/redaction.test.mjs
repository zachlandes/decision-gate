import test from "node:test";
import assert from "node:assert/strict";
import { createRedactor, privateKeyLines } from "../lib/redaction.mjs";

// The built-in never-send rules on their own, as a caller applies them to piped lines: a private
// key spread over lines is found across them first, then each line is redacted and the request
// must pass the final check. Every redacted line must also count as clean, the per-string half of
// that check, so a caller can hold back one line instead of a whole request
const redactor = createRedactor();
function send(input) {
  const lines = input.split("\n");
  const keyLines = privateKeyLines(lines);
  const sent = lines.map((line) => redactor.redact(keyLines.get(line) ?? line)).filter((line) => line.trim());
  const body = JSON.stringify({ state: { items: Object.fromEntries(sent.map((line, i) => [`i${i + 1}`, line])) } });
  redactor.check(body);
  for (const line of sent) assert.ok(redactor.clean(line), line);
  return { sent, body };
}
// Identical redacted lines share one judgment, so each distinct text is sent once
const distinct = (items) => [...new Set(items)].sort();

test("readable file paths, including digit-bearing camelCase names and @2x assets, are sent unchanged", () => {
  const paths = [
    "./packages/i18n/src/translations/localeLoader.ts",
    "./src/components/dashboard/v2/widgets/chart_legend.tsx",
    "./docs/2024/meeting-notes/quarterly_planning_review.md",
    "./src/components/Dashboard/v2/widgets/ChartLegend2Item.tsx",
    "./src/test/java/com/example/service/UserServiceImpl2Test.java",
    "./lib/utils/xmlHttpRequest/handlers/v1/parseHTTP2Response.js",
    "./test/fixtures/i18n/en-US/messages/errors/http404NotFound.json",
    "./src/encoding/encodeUtf8ToBase64Url/encodeUtf8ToBase64Url.ts",
    "./src/crypto/sha256Hmac/hmacSha256Digest.ts",
    "./vendor/github.com/aws/aws-sdk-go-v2/service/s3/api_op_PutObject.go",
    "./src/checkout/Step3ShippingAddress/Step3ShippingAddress.tsx",
    "./node_modules/typescript/lib/lib.es2015.collection.d.ts",
    "./ios/App/Assets.xcassets/AppIcon.appiconset/Icon-App-83.5x83.5@2x.png",
    "./public/images/logo@2x.png",
    "./migrations/20240115123456_add_user_profiles_table.sql",
    "./src/features/oauth2/components/OAuth2CallbackHandler.tsx",
    "./android/app/src/main/res/drawable-xxhdpi/ic_launcher_foreground.png",
    "./services/indexer_v3/internal/k8s/deployment_config_v1beta1.yaml",
    "./src/graphql/__generated__/GetUserProfileV2Query.graphql.ts",
    "./packages/ui/src/components/Grid/Grid12Column/Grid12ColumnLayout.stories.tsx"
  ];
  assert.equal(paths.length, 20);
  const kebab = ["./src/tasks/pk-generate-primary-key-migrations.ts", "./scripts/sk-learn-model-v2-evaluation.py", "./docs/rk-2024-release-notes-draft.md", "./src/sk-integration-test-fixtures/setup.ts", "./public/icons/icon@2x.PNG", "./public/images/hero@2x.avif"];
  assert.deepEqual(send([...paths, ...kebab].join("\n")).sent.sort(), [...paths, ...kebab].sort());
});

// Deterministic so a failure names the same generated key on every run
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("ten generated keys of every known format, in each provider's real shape, are all redacted", () => {
  const random = seeded(20260925);
  const from = (alphabet) => (n) => Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const alnum = from(upper + upper.toLowerCase() + "0123456789");
  const b64url = from(upper + upper.toLowerCase() + "0123456789-_");
  const digits = from("0123456789");
  const upperDigits = from(upper + "0123456789");
  const hex = from("0123456789abcdef");
  const base64 = from(upper + upper.toLowerCase() + "0123456789+/");
  // Prefixes are split so the fake credentials never appear whole in the source
  const formats = [
    ["[api key]", () => "s" + "k-proj-" + b64url(156)],
    ["[api key]", () => "s" + "k-svcacct-" + b64url(156)],
    ["[api key]", () => "s" + "k-admin-" + b64url(156)],
    ["[api key]", () => "s" + "k-None-" + b64url(48)],
    ["[api key]", () => "s" + "k-ant-api03-" + b64url(93) + "AA"],
    ["[api key]", () => "s" + "k-ant-admin01-" + b64url(93) + "AA"],
    ["[api key]", () => "s" + "k-" + alnum(46) + "Q7"],
    ["[api key]", () => "s" + "k_live_" + alnum(99)],
    ["[api key]", () => "r" + "k_test_" + alnum(99)],
    ["[github token]", () => "gh" + "p_" + alnum(36)],
    ["[github token]", () => "gh" + "o_" + alnum(36)],
    ["[github token]", () => "gh" + "s_" + alnum(36)],
    ["[github token]", () => "github" + "_pat_" + alnum(22) + "_" + alnum(59)],
    ["[gitlab token]", () => "gl" + "pat-" + b64url(20)],
    ["[npm token]", () => "np" + "m_" + alnum(36)],
    ["[slack token]", () => "xo" + "xb-" + digits(12) + "-" + digits(13) + "-" + alnum(24)],
    ["[slack token]", () => "xo" + "xp-" + digits(12) + "-" + digits(12) + "-" + digits(13) + "-" + hex(32)],
    ["[slack token]", () => "xo" + "xa-2-" + digits(12) + "-" + alnum(24)],
    ["[aws key]", () => "AK" + "IA" + upperDigits(16)],
    ["[aws key]", () => "AS" + "IA" + upperDigits(16)],
    ["[google key]", () => "AI" + "za" + b64url(35)],
    ["[token]", () => "ey" + "J" + b64url(33) + "." + b64url(60) + "." + b64url(43)],
    ["[email]", () => alnum(8).toLowerCase() + "@" + digits(3) + ".com"],
    ["[github token]", () => "gh" + "u_" + alnum(36)],
    ["[github token]", () => "gh" + "r_" + alnum(76)],
    ["Bearer [token]", () => "Bearer " + b64url(40)],
    ["Authorization: [redacted]", () => "Authorization: Basic " + base64(30) + "=="],
    ["https://[redacted]@example.com/path", () => "https://" + alnum(6).toLowerCase() + ":" + alnum(20) + "@example.com/path"],
    ["postgres://[redacted]@db:5432/app", () => "postgres://app:" + alnum(24) + "@db:5432/app"]
  ];
  const cases = formats.flatMap(([replacement, make]) => Array.from({ length: 10 }, () => [make(), replacement]));
  assert.ok(cases.some(([key]) => key.startsWith("s" + "k-proj-") && /-.*-/.test(key.slice(8))));
  const lines = cases.map(([key], i) => `login ${i} ${key}`);
  const { sent, body } = send(lines.join("\n"));
  assert.deepEqual(sent.sort(), cases.map(([, replacement], i) => `login ${i} ${replacement}`).sort());
  for (const [key] of cases) {
    assert.ok(!body.includes(key), key);
    // A caller that skipped redaction is refused by the final check, not trusted
    assert.equal(redactor.clean(`login ${key}`), false, key);
    assert.throws(() => redactor.check(JSON.stringify({ state: { text: `login ${key}` } })), /never-send/);
  }
});

test("code lines keep everything but a secret's value", () => {
  const unchanged = [
    "function login(token: string, user: User) {",
    '{ key: item.id, label: "Save" }',
    "items.map((key) => cache.get(key));",
    "items.map(key => key.id)",
    "export interface Session { token: string; expiresAt: Date }",
    "const { password, ...rest } = user;",
    'if (!token) throw new Error("missing token");',
    "def verify(password: str, hashed: bytes) -> bool:",
    "    token: Optional[str] = None",
    "api_key: ${{ secrets.OPENAI_API_KEY }}",
    "  password: ${DB_PASSWORD}",
    "type Props = { apiKey: string; onChange: (key: string) => void };",
    "const secretName = process.env.SECRET_NAME;",
    'logger.info("token refreshed", { userId });',
    "const tokenCount = tokens.length;",
    "- name: Rotate API key",
    "if (password.length < 12) return false;",
    '@app.post("/token")',
    'return jwt.encode(payload, key, algorithm="HS256")',
    "password_hash = bcrypt.hash(password, rounds)",
    "for key, value in settings.items():",
    "  - key: ENVIRONMENT",
    "api_key=xyz",
    "password = get_password()",
    "const token = await fetchToken(user)",
    "token = getToken();",
    "api_key = os.environ['API_KEY']",
    "if (token === expectedToken) {",
    "monkey=banana tokens=5 keyboard=qwerty"
  ];
  const secret = [
    ['const password = "hunter2secret";', 'const password = "[redacted]";'],
    ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=[redacted]"],
    ["password: hunter2secret99", "password: [redacted]"],
    ['secret: "two words here"', 'secret: "[redacted]"'],
    ['{"token": "abc def", "user": "zed"}', '{"token": "[redacted]", "user": "zed"}'],
    ["api_key=xyz9", "api_key=[redacted]"],
    ["'password' => 'hunter2secret',", "'password' => '[redacted]',"],
    [':password => "rubysecret"', ':password => "[redacted]"'],
    ['if (password === "hunter2secret") {', 'if (password === "[redacted]") {'],
    ['if (password !== "x") {', 'if (password !== "[redacted]") {'],
    ['password != "x"', 'password != "[redacted]"'],
    ["password = `hunter2 secret` + suffix", "password = `[redacted]` + suffix"],
    ["DB_PASSWORD=abc;def'ghi", "DB_PASSWORD=[redacted]"],
    ["password=abc)def", "password=[redacted]"],
    ["KEY=val}ue", "KEY=[redacted]"],
    ["password_reset_url: /account/reset", "password_reset_url: [redacted]"],
    ["  key: user-profile-panel", "  key: [redacted]"],
    ["const tokenCount = 5", "const tokenCount = [redacted]"],
    ["DBPassword=hunter2", "DBPassword=[redacted]"],
    ["APIToken=abc1", "APIToken=[redacted]"],
    ["APIKey=abc1", "APIKey=[redacted]"],
    ["JWTSecret=abc1", "JWTSecret=[redacted]"],
    ["password=[bracketed]secret", "password=[redacted]"],
    ['password="unterminated secret', 'password="[redacted]"'],
    ['"password": "ab\\"cdsecret"', '"password": "[redacted]"'],
    ["{ key: 'settings', label: t('nav.settings') }", "{ key: '[redacted]', label: t('nav.settings') }"],
    ['sortKey: "createdAt",', 'sortKey: "[redacted]",'],
    ["{password=abc123}", "{password=[redacted]}"],
    ["--token=abc123 --verbose", "--token=[redacted] --verbose"],
    ["SECRET_KEY_BASE=3f4a9c1e8b7d6a5f4e3d2c1b0a9f8e7d", "SECRET_KEY_BASE=[redacted]"],
    ["DB_PASSWORD_PROD=hunter2hunter2", "DB_PASSWORD_PROD=[redacted]"],
    ["API_KEY_V2=abcd1234efgh", "API_KEY_V2=[redacted]"],
    ["GITHUB_TOKEN_READONLY=abc123def456", "GITHUB_TOKEN_READONLY=[redacted]"],
    ['password_confirmation: "hunter2"', 'password_confirmation: "[redacted]"'],
    ['const apiKey = "xyz";', 'const apiKey = "[redacted]";'],
    ["export OPENAI_API_KEY=" + "s" + "k-proj-" + "a1B2-c3D4_e5F6-g7H8i9J0", "export OPENAI_API_KEY=[redacted]"]
  ];
  assert.ok(unchanged.length + secret.length >= 30);
  assert.deepEqual(distinct(send([...unchanged, ...secret.map(([line]) => line)].join("\n")).sent), distinct([...unchanged, ...secret.map(([, sent]) => sent)]));
});

test("credentials in real config formats lose their values while code references pass", () => {
  // Synthetic values in each file format, never real credentials
  const cases = [
    ["[default]", "[default]"],
    ["aws_access_key_id = " + "AK" + "IA" + "Q2W3E4R5T6Y7U8I9", "aws_access_key_id = [redacted]"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws_secret_access_key = [redacted]"],
    ["password = pypi-AgEIcHlwaS5vcmcCJDk", "password = [redacted]"],
    ["[client]", "[client]"],
    ["password = hunter2", "password = [redacted]"],
    ["DATABASE_PASSWORD=s3cr3t-Pa55", "DATABASE_PASSWORD=[redacted]"],
    ["SECRET_KEY_BASE=3f4a9c1e8b7d6a5f4e3d2c1b0a9f8e7d", "SECRET_KEY_BASE=[redacted]"],
    ['    "DBPassword": "hunter2",', '    "DBPassword": "[redacted]",'],
    ['    "ApiKey": "abc123-def456",', '    "ApiKey": "[redacted]",'],
    ['    "ClientSecret": "Zm9vYmFy"', '    "ClientSecret": "[redacted]"'],
    ['api_token = "tok_2f9c8e7a"', 'api_token = "[redacted]"'],
    ["token = abc123def456", "token = [redacted]"],
    ["export GITHUB_TOKEN_READONLY=abc123def456", "export GITHUB_TOKEN_READONLY=[redacted]"],
    ["mycli deploy --token=abc123 --verbose", "mycli deploy --token=[redacted] --verbose"],
    ["connect(host=h, password=pw, user=u)", "connect(host=h, password=pw, user=u)"],
    ["Client(api_key=api_key)", "Client(api_key=api_key)"],
    ["Client(api_key='x-live-1')", "Client(api_key='[redacted]')"],
    ["connect(password=abc123, timeout=5)", "connect(password=[redacted], timeout=5)"]
  ];
  assert.deepEqual(distinct(send(cases.map(([line]) => line).join("\n")).sent), distinct(cases.map(([, sent]) => sent)));
});

test("an authorization or auth credential is redacted in header and JSON text, but profile and posting prose is kept", () => {
  // Synthetic credentials, never real ones
  const b64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
  const hex = "9f3c2a1e4b7d8c6a5f4e3d2c1b0a9f8e";
  const redacted = [
    ["Authorization: Bearer abcdefghijklmnop", "Authorization: [redacted]"],
    ["authorization: bearer abc.def-ghi", "authorization: [redacted]"],
    ["AUTHORIZATION: BEARER x7", "AUTHORIZATION: [redacted]"],
    ["Authorization: Basic " + b64, "Authorization: [redacted]"],
    ["authorization: basic dTpw", "authorization: [redacted]"],
    ["Authorization: Token 1234", "Authorization: [redacted]"],
    ["Authorization:Token token=abc, user=zed", "Authorization:[redacted]"],
    ['Authorization: Digest username="Mufasa", realm="x@example", nonce="dcd98b71", response="' + hex + '"', "Authorization: [redacted]"],
    ["Authorization: Negotiate YIIGhgYGKwYBBQUCoIIGejCC", "Authorization: [redacted]"],
    ["Authorization: AWS4-HMAC-SHA256 Credential=x/20260926/us-east-1/s3/aws4_request, Signature=" + hex, "Authorization: [redacted]"],
    ["Proxy-Authorization: Basic " + b64, "Proxy-Authorization: [redacted]"],
    ["Authorization: " + hex, "Authorization: [redacted]"],
    ["authorization=" + b64, "authorization=[redacted]"],
    ["auth=" + hex + "&user=zed", "auth=[redacted]&user=zed"],
    ["AUTH: " + b64, "AUTH: [redacted]"],
    ["basic_auth: " + hex, "basic_auth: [redacted]"],
    ['{"Authorization": "Bearer abc.def-ghi", "x": 1}', '{"Authorization": "[redacted]", "x": 1}'],
    ['{"authorization":"Token 1234"}', '{"authorization":"[redacted]"}'],
    ['{"auth": "' + hex + '", "user": "zed"}', '{"auth": "[redacted]", "user": "zed"}'],
    ["headers = {'Authorization': 'Basic " + b64 + "'}", "headers = {'Authorization': '[redacted]'}"],
    ["authorization='Bearer x'", "authorization='[redacted]'"],
    ['curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com', 'curl -H "Authorization: [redacted]" https://api.example.com'],
    ["curl -H 'Authorization: Digest username=\"u\", response=\"" + hex + "\"' https://x", "curl -H 'Authorization: [redacted]' https://x"],
    ['curl -H "Authorization: Digest username=\\"u\\", response=\\"' + hex + '\\"" https://x', 'curl -H "Authorization: [redacted]" https://x']
  ];
  const kept = [
    "work authorization: F-1 OPT",
    "Work Authorization: US citizen",
    "Authorization: must be authorized to work in the US without sponsorship",
    "Work authorization: Green card holder",
    "Work Authorization = H-1B transfer",
    "authorization: EAD (C8)",
    '{"work_authorization": "F-1 OPT", "degree": "BS"}',
    '{"authorization": "US citizen"}',
    "Employment authorization: not required",
    "auth: required",
    "auth=internationalization",
    "auth: Basic",
    "work_authorization: OPT-STEM-Extension",
    '{"work_authorization": "US-Citizen-No-Sponsorship"}',
    "Work authorization: PermanentResident",
    "work authorization: Canadian/US-dual-citizen",
    "authorization: US-citizen-or-green-card",
    "Authorization: Signature required on the I-9",
    "Work Authorization: Basic eligibility required",
    "Work authorization: Key requirement for this role",
    "Employment Authorization: Mutual agreement",
    "authorization: Digest of eligibility rules",
    "work authorization: OAuth not applicable",
    'headers = {"Authorization": f"Bearer {token}"}',
    "Authorization: [redacted]"
  ];
  assert.deepEqual(distinct(send([...redacted.map(([line]) => line), ...kept].join("\n")).sent), distinct([...redacted.map(([, sent]) => sent), ...kept]));
  // A caller that skipped redaction is refused by the final check
  for (const [line] of redacted) assert.equal(redactor.clean(line), false, line);
});

for (const [name, kind, terminated, prefix] of [
  ["a private key piped as lines spanning batches", "RSA PRIVATE KEY", true, () => ""],
  ["a private key cut off before its END line, as by head", "RSA PRIVATE KEY", false, () => ""],
  ["a PGP private key block with armour headers and a blank line", "PGP PRIVATE KEY BLOCK", true, () => ""],
  ["a private key in rg -n output", "RSA PRIVATE KEY", true, (i) => `keys/id_rsa:${i + 1}:`],
  ["a private key in rg -n output under a path with spaces", "RSA PRIVATE KEY", true, (i) => `Google Drive/keys/server.pem:${i + 1}:`],
  ["a private key in rg -C context lines", "RSA PRIVATE KEY", true, (i) => i === 0 ? "keys/a.pem:1:" : `keys/a.pem-${i + 1}-`],
  ["a cut-off private key in rg -n output", "OPENSSH PRIVATE KEY", false, (i) => `keys/id_ed25519:${i + 1}:`],
  ["a private key added in git diff output", "RSA PRIVATE KEY", true, () => "+"],
  ["a private key in cat -n output", "EC PRIVATE KEY", true, (i) => `${String(i + 1).padStart(6)}\t`],
  ["a PGP key block in rg -n output with a blank armour line", "PGP PRIVATE KEY BLOCK", true, (i) => `keys/sub.asc:${i + 1}:`]
]) {
  test(`${name} sends none of its key text, keeps each prefix and leaves later lines alone`, () => {
    const body = Array.from({ length: 30 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC".slice(0, 40)}${i}`);
    const pgp = kind.startsWith("PGP");
    const key = [
      `-----BEGIN ${kind}-----`,
      ...(pgp ? ["Version: GnuPG v2", ""] : []),
      ...body,
      ...(terminated ? ["AQAB==", ...(pgp ? ["=Xk2a"] : []), `-----END ${kind}-----`] : [])
    ];
    const block = key.map((line, i) => prefix(i) + line);
    const filler = Array.from({ length: 20 }, (_, i) => `login ${i}`);
    const { sent, body: sentBody } = send([...filler.slice(0, 10), ...block, ...filler.slice(10)].join("\n"));
    const expected = key.flatMap((line, i) => line ? [prefix(i) + "[private key]"] : prefix(i).trim() ? [prefix(i)] : []);
    assert.deepEqual(distinct(sent.filter((item) => !item.startsWith("login"))), distinct(expected));
    assert.deepEqual(distinct(sent.filter((item) => item.startsWith("login"))), distinct(filler));
    for (const line of key.filter((line) => line.length > 8)) assert.ok(!sentBody.includes(line), line);
  });
}

for (const [name, open, close, prefix] of [
  ["a multi-line .env value", 'PRIVATE_KEY="', '"', () => ""],
  ["a multi-line .env value in rg -n output", 'PRIVATE_KEY="', '"', (i) => `.env:${i + 4}:`],
  ["a Python triple-quoted string", 'SIGNING_KEY = """', '"""', () => ""],
  ["a JS template literal", "const key = `", "`", () => ""],
  ["a Go raw string", "var testKey = `", "`", () => ""],
  ["a JS template literal closed by a statement end", "const key = `", "`;", () => ""],
  ["a Python triple-quoted call argument", 'key = load_pem_private_key(b"""', '""")', () => ""],
  ["a Go test-table raw string", "{pem: `", "`,", () => ""]
]) {
  test(`a private key in ${name} sends none of its key text`, () => {
    const body = Array.from({ length: 30 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC".slice(0, 40)}${i}`);
    const key = [`${open}-----BEGIN RSA PRIVATE KEY-----`, ...body, "AQAB==", `-----END RSA PRIVATE KEY-----${close}`];
    const filler = Array.from({ length: 20 }, (_, i) => `login ${i}`);
    const { sent, body: sentBody } = send([...filler.slice(0, 10), ...key.map((line, i) => prefix(i) + line), ...filler.slice(10)].join("\n"));
    const opening = sent.filter((item) => item.startsWith(prefix(0) + open.split(/\s|=/)[0]));
    assert.equal(opening.length, 1);
    assert.ok(!opening[0].includes("BEGIN"), opening[0]);
    const rest = key.slice(1).map((_, i) => `${prefix(i + 1)}[private key]`);
    assert.deepEqual(distinct(sent.filter((item) => !item.startsWith("login") && item !== opening[0])), distinct(rest));
    assert.deepEqual(distinct(sent.filter((item) => item.startsWith("login"))), distinct(filler));
    for (const line of body) assert.ok(!sentBody.includes(line), line);
  });
}

test("a private key held on one line with escaped newlines is redacted from BEGIN through END", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC";
  const sent = send(`login {"pem": "-----BEGIN PRIVATE KEY-----\\n${body}\\nAQAB==\\n-----END PRIVATE KEY-----\\n", "user": "zed"}`);
  assert.deepEqual(sent.sent, ['login {"pem": "[private key]\\n", "user": "zed"}']);
  assert.ok(!sent.body.includes(body));
});

test("a private-key marker held in a string constant does not blank the lines after it", () => {
  const lines = [
    "src/pem.ts:1:// Headers for detecting key files",
    'src/pem.ts:3:const HEADER = "-----BEGIN RSA PRIVATE KEY-----";',
    "src/login.ts:1:export function signIn(user) {",
    "src/login.ts:2:  return login(user);"
  ];
  assert.deepEqual(send(lines.join("\n")).sent.sort(), [
    "src/pem.ts:1:// Headers for detecting key files",
    'src/pem.ts:3:const HEADER = "[private key]',
    "src/login.ts:1:export function signIn(user) {",
    "src/login.ts:2:  return login(user);"
  ].sort());
});
