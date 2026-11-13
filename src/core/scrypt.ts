// scrypt (RFC 7914) in plain TypeScript, so the browser can open the CLI's encrypted key files
// without a dependency. PBKDF2-HMAC-SHA256 comes from WebCrypto; Salsa20/8, BlockMix and ROMix are
// here. Tested against Node's crypto.scryptSync (tests/keyfile.test.ts).

function salsa208(B: Uint32Array, x: Uint32Array) {
  x.set(B);
  const R = (a: number, b: number) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4]! ^= R(x[0]! + x[12]!, 7); x[8]! ^= R(x[4]! + x[0]!, 9); x[12]! ^= R(x[8]! + x[4]!, 13); x[0]! ^= R(x[12]! + x[8]!, 18);
    x[9]! ^= R(x[5]! + x[1]!, 7); x[13]! ^= R(x[9]! + x[5]!, 9); x[1]! ^= R(x[13]! + x[9]!, 13); x[5]! ^= R(x[1]! + x[13]!, 18);
    x[14]! ^= R(x[10]! + x[6]!, 7); x[2]! ^= R(x[14]! + x[10]!, 9); x[6]! ^= R(x[2]! + x[14]!, 13); x[10]! ^= R(x[6]! + x[2]!, 18);
    x[3]! ^= R(x[15]! + x[11]!, 7); x[7]! ^= R(x[3]! + x[15]!, 9); x[11]! ^= R(x[7]! + x[3]!, 13); x[15]! ^= R(x[11]! + x[7]!, 18);
    x[1]! ^= R(x[0]! + x[3]!, 7); x[2]! ^= R(x[1]! + x[0]!, 9); x[3]! ^= R(x[2]! + x[1]!, 13); x[0]! ^= R(x[3]! + x[2]!, 18);
    x[6]! ^= R(x[5]! + x[4]!, 7); x[7]! ^= R(x[6]! + x[5]!, 9); x[4]! ^= R(x[7]! + x[6]!, 13); x[5]! ^= R(x[4]! + x[7]!, 18);
    x[11]! ^= R(x[10]! + x[9]!, 7); x[8]! ^= R(x[11]! + x[10]!, 9); x[9]! ^= R(x[8]! + x[11]!, 13); x[10]! ^= R(x[9]! + x[8]!, 18);
    x[12]! ^= R(x[15]! + x[14]!, 7); x[13]! ^= R(x[12]! + x[15]!, 9); x[14]! ^= R(x[13]! + x[12]!, 13); x[15]! ^= R(x[14]! + x[13]!, 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i]! + x[i]!) | 0;
}

/** BlockMix over 2r 64-byte blocks of `B`, output into `Y`. */
function blockMix(B: Uint32Array, Y: Uint32Array, r: number, X: Uint32Array, tmp: Uint32Array) {
  X.set(B.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) X[j]! ^= B[i * 16 + j]!;
    salsa208(X, tmp);
    // Even blocks go to the first half, odd to the second.
    Y.set(X, (i % 2 === 0 ? i / 2 : r + (i - 1) / 2) * 16);
  }
}

function roMix(B: Uint32Array, N: number, r: number) {
  const words = 32 * r;
  const V = new Uint32Array(words * N);
  const X = new Uint32Array(B);
  const Y = new Uint32Array(words);
  const T = new Uint32Array(16);
  const tmp = new Uint32Array(16);
  for (let i = 0; i < N; i++) {
    V.set(X, i * words);
    blockMix(X, Y, r, T, tmp);
    X.set(Y);
  }
  for (let i = 0; i < N; i++) {
    const j = X[(2 * r - 1) * 16]! & (N - 1);
    for (let k = 0; k < words; k++) X[k]! ^= V[j * words + k]!;
    blockMix(X, Y, r, T, tmp);
    X.set(Y);
  }
  B.set(X);
}

async function pbkdf2(password: Uint8Array, salt: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", password as BufferSource, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: 1 }, key, bytes * 8));
}

export async function scrypt(password: Uint8Array, salt: Uint8Array, opts: { N: number; r: number; p: number; dkLen: number }): Promise<Uint8Array> {
  const { N, r, p, dkLen } = opts;
  if (N < 2 || (N & (N - 1)) !== 0) throw new Error("scrypt: N must be a power of two");
  if (N > 1 << 20 || r > 32 || p > 16) throw new Error("scrypt: parameters too large");
  const blockBytes = 128 * r;
  const B = await pbkdf2(password, salt, p * blockBytes);
  const view = new DataView(B.buffer, B.byteOffset, B.byteLength);
  for (let i = 0; i < p; i++) {
    const words = new Uint32Array(32 * r);
    for (let k = 0; k < words.length; k++) words[k] = view.getUint32(i * blockBytes + k * 4, true);
    roMix(words, N, r);
    for (let k = 0; k < words.length; k++) view.setUint32(i * blockBytes + k * 4, words[k]!, true);
  }
  return pbkdf2(password, B, dkLen);
}
