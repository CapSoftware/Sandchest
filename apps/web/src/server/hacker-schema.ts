/** What a saved hacker must be: every look from the lists in lib/hacker, and a valid name. Shared by recruiting and customizing. */
import { z } from "zod";
import { HOODIES, MAX_STICKERS, PHOSPHORS, ROOMS, SHELLS, STICKERS, validHandle, VOICES } from "@/lib/hacker";

const oneOf = (list: readonly { id: string }[]) => z.enum(list.map((item) => item.id) as [string, ...string[]]);

export const HackerSchema = z.object({
  handle: z.string().refine(validHandle),
  hoodie: oneOf(HOODIES),
  shell: oneOf(SHELLS),
  phosphor: oneOf(PHOSPHORS),
  room: oneOf(ROOMS),
  stickers: z.array(oneOf(STICKERS)).max(MAX_STICKERS),
  voice: oneOf(VOICES),
});
