export function padTo4(value: number): number {
  const mod = value % 4;
  return mod === 0 ? value : value + (4 - mod);
}

export function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
