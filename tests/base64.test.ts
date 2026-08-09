import { describe, it, expect } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  decodeVector,
  encodeVector,
} from "../src/core/util/base64.ts";

describe("base64", () => {
  it("matches known values", () => {
    expect(bytesToBase64(new TextEncoder().encode(""))).toBe("");
    expect(bytesToBase64(new TextEncoder().encode("f"))).toBe("Zg==");
    expect(bytesToBase64(new TextEncoder().encode("fo"))).toBe("Zm8=");
    expect(bytesToBase64(new TextEncoder().encode("foo"))).toBe("Zm9v");
    expect(bytesToBase64(new TextEncoder().encode("foob"))).toBe("Zm9vYg==");
    expect(bytesToBase64(new TextEncoder().encode("fooba"))).toBe("Zm9vYmE=");
    expect(bytesToBase64(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
  });

  it("round-trips arbitrary bytes including 0x00 and 0xff", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255, 0, 42]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it("rejects input that is not base64", () => {
    expect(() => base64ToBytes("not*valid")).toThrow(/base64/);
  });
});

describe("vector encoding", () => {
  it("produces an exact, byte-pinned string", () => {
    // Exactness, not just round-tripping. A round-trip test passes even when
    // the encoder and decoder share an endianness or offset bug — and that bug
    // would only surface later, as garbage vectors, when the Tauri webview
    // reads what the Node harness wrote.
    //
    // Little-endian IEEE-754: 1 -> 00 00 80 3F, 2 -> 00 00 00 40,
    // -1 -> 00 00 80 BF, 0.5 -> 00 00 00 3F
    const vector = new Float32Array([1, 2, -1, 0.5]);
    expect(encodeVector(vector)).toBe("AACAPwAAAEAAAIC/AAAAPw==");
  });

  it("decodes back to the same floats", () => {
    const vector = new Float32Array([0, 1, -1, 0.5, 3.25, -7.5]);
    expect([...decodeVector(encodeVector(vector))]).toEqual([...vector]);
  });

  it("survives a realistic 384-dimension vector", () => {
    const vector = new Float32Array(384);
    for (let i = 0; i < vector.length; i++) vector[i] = Math.sin(i) / 2;
    const decoded = decodeVector(encodeVector(vector));
    expect(decoded.length).toBe(384);
    for (let i = 0; i < vector.length; i++) {
      expect(decoded[i]).toBeCloseTo(vector[i] ?? 0, 6);
    }
  });

  it("refuses a payload that is not a whole number of float32s", () => {
    expect(() => decodeVector(bytesToBase64(new Uint8Array([1, 2, 3])))).toThrow(
      /float32/,
    );
  });
});
