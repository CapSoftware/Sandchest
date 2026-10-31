/**
 * Yields the `data` payload of each server-sent event in `body`.
 *
 * Handles CRLF and LF line endings, multi-line data fields, comments and
 * chunk boundaries that split lines. Cancels the underlying stream if the
 * consumer stops early.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let finished = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let start = 0;
      let newline: number;
      while ((newline = buffer.indexOf("\n", start)) !== -1) {
        const end = newline > start && buffer.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
        const line = buffer.slice(start, end);
        start = newline + 1;

        if (line === "") {
          if (data.length > 0) {
            yield data.join("\n");
            data = [];
          }
        } else if (line.startsWith("data:")) {
          data.push(line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5));
        }
      }
      buffer = buffer.slice(start);
    }

    // A final event may arrive without the trailing blank line.
    buffer += decoder.decode();
    const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (tail.startsWith("data:")) data.push(tail.slice(tail.charCodeAt(5) === 32 ? 6 : 5));
    if (data.length > 0) yield data.join("\n");
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
