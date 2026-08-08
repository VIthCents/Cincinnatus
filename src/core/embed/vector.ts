/**
 * Vector maths.
 *
 * There is no vector database here and there does not need to be (constraint
 * 7). Brute-force cosine over 384-dimensional normalized float32 measured at
 * ~3.3M vectors/sec on the development machine: 1.9 ms at 5,000 jobs, 15 ms at
 * 50,000. The ranking step is not the slow part of a run — embedding is.
 */

/**
 * Dot product. For L2-normalized vectors this *is* the cosine similarity, which
 * is why {@link cosine} is not used on the hot path.
 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/** Cosine similarity for vectors that may not be normalized. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    sum += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return sum / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** L2-normalize in place and return the same array. */
export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    norm += x * x;
  }
  if (norm === 0) return v;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) {
    v[i] = (v[i] ?? 0) * inv;
  }
  return v;
}
