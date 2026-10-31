export const site = {
  name: "Sandchest",
  title: "Sandchest — Add a hacker to your team",
  description:
    "Sandchest acts like a real hacker embedded in your team, using abliterated, unrestricted models to find real vulnerabilities in your code before attackers do.",
  url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/CapSoftware/Sandchest",
  links: {
    getStarted: "/sign-in",
    docs: "/docs",
    terms: "/terms",
    privacy: "/privacy",
    acceptableUse: "/acceptable-use",
  },
} as const;
