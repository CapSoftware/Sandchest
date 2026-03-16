/** Convert 16-byte UUID bytes to the lowercase hex string used on the gRPC wire. */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** Convert a 32-char hex string to a 16-byte Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'))
}
