import type { MetadataRoute } from "next";
import { brandAsset, site } from "@/lib/site";

/** Install metadata and the home screen icons, drawn by `bun run icons`. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: site.name,
    short_name: site.name,
    description: site.description,
    start_url: "/",
    display: "standalone",
    background_color: "#0d0a07",
    theme_color: "#0d0a07",
    icons: [
      { src: brandAsset("/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: brandAsset("/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: brandAsset("/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
