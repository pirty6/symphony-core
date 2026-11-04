import { describe, expect, it } from 'vitest';
import { REDACTED, scrubText, scrubValue, StreamScrubber } from './scrub.js';

// Built at run time, so this file holds no string a secret scanner would flag.
const gh = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const pat = `github_pat_${'11ABCDEFG0'.repeat(3)}`;
const aws = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const jwt = `eyJ${'hbGciOiJIUzI1'}.eyJ${'zdWIiOiIxMjM0'}.${'SflKxwRJSMeKKF2QT4fwpM'}`;
const key = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${'x'.repeat(40)}\n-----END RSA PRIVATE KEY-----`;

describe('scrubText', () => {
  it.each([
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
  ])('replaces %s', (_n, text, want) => {
    expect(scrubText(text)).toBe(want);
    // Idempotent: a scrubbed record scrubs to itself.
    expect(scrubText(want)).toBe(want);
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
    for (const text of [
      'const token = getToken(); const password = form.password; if (apiKey === undefined) return;',
      'commit 8b76a54a8e14b0f417b00430b0f16121aedad4c8 and sha256 d85bff5e28aa11bb22cc33dd44ee55ff',
      "export const TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'TOKEN'] as const;",
      'https://office@dev.azure.com/office/OC/_git/office-bohemia/pullrequest/5952552',
      'src/runtime/copilot-provider.ts:906 — the last valid answer wins `valid = args;`',
      'password: string; secret?: boolean;',
      'const conn = `Server=x;Password=${process.env.DB_PASSWORD};`;',
    ])
      expect(scrubText(text)).toBe(text);
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

describe('StreamScrubber', () => {
  it('streamed in random pieces, always equals scrubbing the whole text (seeded fuzz)', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const secrets = [
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
    const filler = ['word ', 'x'.repeat(rnd(900) + 1), '\n', '{"a": "', '", ', ' '];
    for (let round = 0; round < 200; round += 1) {
      let text = '';
      for (let k = 0; k < 12; k += 1)
        text += rnd(3) === 0 ? secrets[rnd(secrets.length)] : filler[rnd(filler.length)];
      const size = rnd(60) + 1;
      expect(stream(text, size)).toBe(scrubText(text));
    }
  });

  it('a private key longer than what is held back, in any piece size', () => {
    const body = Array.from(
      { length: 25 },
      (_, i) => `MIIEow${String(i).padStart(2, '0')}${'Q'.repeat(56)}`,
    );
    const long = `before\n-----BEGIN RSA PRIVATE KEY-----\n${body.join('\n')}\n-----END RSA PRIVATE KEY-----\nafter`;
    for (const size of [5, 40, 2000]) {
      const out = stream(long, size);
      expect(out).toBe('before\n[REDACTED:private-key]\nafter');
    }
  });

  it('a secret with a space in it, inside a line longer than what is held back', () => {
    const pad = 'word '.repeat(160);
    for (const text of [
      `${pad}Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 ${pad}`,
      `{"a": "${'x'.repeat(700)}", "apiKey": "supersecretvalue123", "b": "${'y'.repeat(700)}"}`,
    ]) {
      const out = stream(text, 3);
      expect(out).toBe(scrubText(text));
      expect(out).not.toMatch(/abcdefghij|supersecret/);
    }
  });

  it('catches a secret split across pieces, wherever the stream is cut', () => {
    const text = `${'some streamed text '.repeat(40)}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\npassword = "Tr0ub4dor&3x"\n${key}\nend ${gh}`;
    for (const size of [1, 3, 7, 50, 333]) {
      const s = new StreamScrubber();
      let out = '';
      for (let i = 0; i < text.length; i += size) out += s.push(text.slice(i, i + size));
      out += s.end();
      expect(out).toBe(scrubText(text));
      expect(out).not.toMatch(/abcdefghij|Tr0ub4dor|MIIEow|ghp_/);
      expect(out).toMatch(REDACTED);
    }
  });
});
