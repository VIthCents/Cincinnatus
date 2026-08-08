/**
 * Base64 for embedding vectors.
 *
 * Hand-written because src/core has neither `Buffer` (Node) nor `btoa` (DOM),
 * and because @tauri-apps/plugin-sql cannot bind binary data at all — vectors
 * are stored as TEXT. See docs/DECISIONS.md.
 *
 * Byte order is pinned to little-endian explicitly. Every platform we target is
 * little-endian today, but "today" is not a guarantee, and a vector written by
 * the Node harness has to be readable by the Tauri webview.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse lookup, -1 for anything that is not a base64 digit. */
const INVERSE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;

    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0b11) << 4) | (b1 >> 4));
    out += has1 ? ALPHABET.charAt(((b1 & 0b1111) << 2) | (b2 >> 6)) : "=";
    out += has2 ? ALPHABET.charAt(b2 & 0b111111) : "=";
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === "=") end--;

  const byteLength = Math.floor((end * 3) / 4);
  const out = new Uint8Array(byteLength);

  let acc = 0;
  let bits = 0;
  let written = 0;

  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? (INVERSE[code] ?? -1) : -1;
    if (digit < 0) {
      throw new Error(`Not valid base64 at position ${i}: "${text.charAt(i)}"`);
    }
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
    }
  }

  return out;
}

/** Encode a vector for storage in a TEXT column. */
export function encodeVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) {
    view.setFloat32(i * 4, vector[i] ?? 0, /* littleEndian */ true);
  }
  return bytesToBase64(bytes);
}

/** Inverse of {@link encodeVector}. */
export function decodeVector(text: string): Float32Array {
  const bytes = base64ToBytes(text);
  if (bytes.length % 4 !== 0) {
    throw new Error(
      `Encoded vector is ${bytes.length} bytes, which is not a whole number of float32s.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  }
  return out;
}
