import { describe, expect, it } from 'vitest';
import { REDACTED, scrubText, scrubValue, StreamScrubber } from './scrub.js';

// Built at run time, so this file holds no string a secret scanner would flag.
const gh = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const pat = `github_pat_${'11ABCDEFG0'.repeat(3)}`;
const aws = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const jwt = `eyJ${'hbGciOiJIUzI1'}.eyJ${'zdWIiOiIxMjM0'}.${'SflKxwRJSMeKKF2QT4fwpM'}`;
const key = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${'x'.repeat(40)}\n-----END RSA PRIVATE KEY-----`;

describe('scrubText', () => {
  const secretCases: readonly (readonly [string, string, string])[] = [
    ['a GitHub token', `token: ${gh} here`, 'token: [REDACTED:github-token] here'],
    ['a fine-grained GitHub token', `GH=${pat}`, 'GH=[REDACTED:github-token]'],
    ['an AWS key id', `id ${aws}.`, 'id [REDACTED:aws-key].'],
    ['a JWT', `jwt ${jwt}`, 'jwt [REDACTED:jwt]'],
    ['a private key block', `a\n${key}\nb`, 'a\n[REDACTED:private-key]\nb'],
    [
      'a storage connection string',
      'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdEFGH1234+/==;EndpointSuffix=core',
      'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=[REDACTED:connection-key];EndpointSuffix=core',
    ],
    [
      'a SAS signature',
      'https://x.blob.core.windows.net/c?sv=2020&sig=AbCdEfGhIjKlMnOpQrStUv%3D',
      'https://x.blob.core.windows.net/c?sv=2020&sig=[REDACTED:sas-signature]',
    ],
    [
      'a bearer token',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      'Authorization: Bearer [REDACTED:bearer-token]',
    ],
    [
      'a password in a URL',
      'git clone https://me:hunter2secret@dev.azure.com/o/p/_git/r',
      'git clone https://me:[REDACTED:url-password]@dev.azure.com/o/p/_git/r',
    ],
    [
      'a quoted secret assignment',
      'const config = { password: "Tr0ub4dor&3x", apiKey: \'k-1234567890\' }',
      'const config = { password: "[REDACTED:secret-value]", apiKey: \'[REDACTED:secret-value]\' }',
    ],
    [
      'a .env line quoted in prose',
      'deploy.sh:2 — hard-coded `export DB_PASSWORD=abcdefgh123`',
      'deploy.sh:2 — hard-coded `export DB_PASSWORD=[REDACTED:secret-env]`',
    ],
    [
      'a .env line',
      'PORT=3000\nDB_PASSWORD=supersecret99\nexport GITHUB_TOKEN_X=abcdefgh12',
      'PORT=3000\nDB_PASSWORD=[REDACTED:secret-env]\nexport GITHUB_TOKEN_X=[REDACTED:secret-env]',
    ],
  ];
  it('replaces each kind of secret with its label', () => {
    const wanted = secretCases.map(([name, , want]) => [name, want]);
    expect(secretCases.map(([name, text]) => [name, scrubText(text)])).toEqual(wanted);
    // Idempotent: a scrubbed record scrubs to itself.
    expect(secretCases.map(([name, , want]) => [name, scrubText(want)])).toEqual(wanted);
  });

  it('a secret two rules match is redacted once, and stays so', () => {
    const once = scrubText(`connect({ token: "${gh}" }); url = "https://me:${gh}@host/x"`);
    expect(once).toBe(
      'connect({ token: "[REDACTED:github-token]" }); url = "https://me:[REDACTED:github-token]@host/x"',
    );
    expect(scrubText(once)).toBe(once);
    expect(scrubText('AccountKey=[REDACTED:connection-key];')).toBe(
      'AccountKey=[REDACTED:connection-key];',
    );
  });

  it('leaves code, hashes and prose alone', () => {
    const texts = [
      'const token = getToken(); const password = form.password; if (apiKey === undefined) return;',
      'commit 8b76a54a8e14b0f417b00430b0f16121aedad4c8 and sha256 d85bff5e28aa11bb22cc33dd44ee55ff',
      "export const TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'TOKEN'] as const;",
      'https://office@dev.azure.com/office/OC/_git/office-bohemia/pullrequest/5952552',
      'src/runtime/copilot-provider.ts:906 — the last valid answer wins `valid = args;`',
      'password: string; secret?: boolean;',
      'const conn = `Server=x;Password=${process.env.DB_PASSWORD};`;',
    ];
    expect(texts.map((text) => scrubText(text))).toEqual(texts);
  });
});

describe('the limits an investigation found (executed, not traced)', () => {
  it('credentials shorter than 16 characters are caught too', () => {
    expect(scrubText('pwd="12345678"')).toBe('pwd="[REDACTED:secret-value]"');
    expect(scrubText('x://u:abc@h.io')).toBe('x://u:[REDACTED:url-password]@h.io');
  });
});

describe('scrubValue', () => {
  it('scrubs every string of a value, and returns the same object when nothing changed', () => {
    const clean = { a: ['x', { b: 'y' }], n: 3 };
    expect(scrubValue(clean)).toBe(clean);
    expect(scrubValue({ a: [`t ${gh}`], keep: { b: 'y' }, n: 3 })).toEqual({
      a: ['t [REDACTED:github-token]'],
      keep: { b: 'y' },
      n: 3,
    });
  });
});

const stream = (text: string, size: number) => {
  const sc = new StreamScrubber();
  let out = '';
  for (let i = 0; i < text.length; i += size) out += sc.push(text.slice(i, i + size));
  return out + sc.end();
};

const FUZZ_SEED = 42;
const FUZZ_ROUNDS = 200;
const PIECES_PER_TEXT = 12;
const fuzzSecrets = [
  gh,
  pat,
  aws,
  jwt,
  key,
  'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  '"apiKey": "supersecretvalue123"',
  'password = "Tr0ub4dor&3x"',
  'https://me:hunter2secret@host/x',
  'AccountKey=abcdEFGH1234+/==;',
  '\nexport DB_PASSWORD=abcdefgh123\n',
];

/** Seeded random texts of secrets and filler, each with the piece size to stream it in. */
function fuzzCases(seed: number, rounds: number): { text: string; size: number }[] {
  let state = seed;
  const rnd = (n: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state % n;
  };
  const filler = ['word ', 'x'.repeat(rnd(900) + 1), '\n', '{"a": "', '", ', ' '];
  const cases: { text: string; size: number }[] = [];
  for (let round = 0; round < rounds; round += 1) {
    let text = '';
    for (let k = 0; k < PIECES_PER_TEXT; k += 1)
      text += rnd(3) === 0 ? fuzzSecrets[rnd(fuzzSecrets.length)] : filler[rnd(filler.length)];
    cases.push({ text, size: rnd(60) + 1 });
  }
  return cases;
}

const HELD_BACK_SIZES = [7, 50, 333];

/** Streamed in pieces of any size, the text scrubs as a whole does, and a secret is redacted. */
function expectRedactedWholeInAnyPieces(text: string): void {
  expect(HELD_BACK_SIZES.map((size) => stream(text, size))).toEqual(
    HELD_BACK_SIZES.map(() => scrubText(text)),
  );
  expect(scrubText(text)).toMatch(REDACTED);
}

describe('scrubValue reads field names', () => {
  it('a value under a field named as a secret is redacted whatever its shape; others are not', () => {
    const v = {
      password: 'hunter2',
      apiKey: 'k1',
      client_secret: 'abc',
      token: '',
      name: 'password',
      usage: { inputTokens: 5, tokens: 'many' },
      list: [{ accessToken: 'opaque-value' }],
    };
    const out = scrubValue(v);
    expect(out).toEqual({
      password: '[REDACTED:secret-field]',
      apiKey: '[REDACTED:secret-field]',
      client_secret: '[REDACTED:secret-field]',
      token: '',
      name: 'password',
      usage: { inputTokens: 5, tokens: 'many' },
      list: [{ accessToken: '[REDACTED:secret-field]' }],
    });
    expect(scrubValue(out)).toBe(out);
  });

  it('a credential used as a key is scrubbed too', () => {
    expect(Object.keys(scrubValue({ [gh]: 1 }))).toEqual(['[REDACTED:github-token]']);
  });
});

describe('StreamScrubber', () => {
  it('streamed in random pieces, always equals scrubbing the whole text (seeded fuzz)', () => {
    const cases = fuzzCases(FUZZ_SEED, FUZZ_ROUNDS);
    expect(cases.map(({ text, size }) => stream(text, size))).toEqual(
      cases.map(({ text }) => scrubText(text)),
    );
  });

  it('a private key longer than what is held back, in any piece size', () => {
    const body = Array.from(
      { length: 25 },
      (_, i) => `MIIEow${String(i).padStart(2, '0')}${'Q'.repeat(56)}`,
    );
    const long = `before\n-----BEGIN RSA PRIVATE KEY-----\n${body.join('\n')}\n-----END RSA PRIVATE KEY-----\nafter`;
    const sizes = [5, 40, 2000];
    expect(sizes.map((size) => stream(long, size))).toEqual(
      sizes.map(() => 'before\n[REDACTED:private-key]\nafter'),
    );
  });

  it('a secret with a space in it, inside a line longer than what is held back', () => {
    const pad = 'word '.repeat(160);
    const texts = [
      `${pad}Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 ${pad}`,
      `{"a": "${'x'.repeat(700)}", "apiKey": "supersecretvalue123", "b": "${'y'.repeat(700)}"}`,
    ];
    const outs = texts.map((text) => stream(text, 3));
    expect(outs).toEqual(texts.map((text) => scrubText(text)));
    expect(outs.join('\n')).not.toMatch(/abcdefghij|supersecret/);
  });

  it('a quoted secret longer than what is held back is not split from its name', () => {
    expectRedactedWholeInAnyPieces(`config password = "${'s3cr3t'.repeat(120)}" end`);
  });

  it('a bearer token longer than what is held back is not split from its name', () => {
    expectRedactedWholeInAnyPieces(`Authorization: Bearer ${'t0k3n'.repeat(130)} done`);
  });

  it('an env secret longer than what is held back is not split from its name', () => {
    expectRedactedWholeInAnyPieces(`export API_TOKEN=${'v4lue'.repeat(130)}\nnext`);
  });

  it('catches a secret split across pieces, wherever the stream is cut', () => {
    const text = `${'some streamed text '.repeat(40)}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\npassword = "Tr0ub4dor&3x"\n${key}\nend ${gh}`;
    const sizes = [1, 3, 7, 50, 333];
    const outs = sizes.map((size) => stream(text, size));
    expect(outs).toEqual(sizes.map(() => scrubText(text)));
    expect(outs.join('\n')).not.toMatch(/abcdefghij|Tr0ub4dor|MIIEow|ghp_/);
    expect(scrubText(text)).toMatch(REDACTED);
  });
});
