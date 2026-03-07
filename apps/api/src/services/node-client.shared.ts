/** Convert 16-byte UUID bytes to the lowercase hex string used on the gRPC wire. */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}
