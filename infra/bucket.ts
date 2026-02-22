import { isProduction } from "./vpc";

export function getArtifactLifecycle(stage: string) {
  const rules = [
    {
      id: "expire-tmp-uploads",
      prefix: "tmp/",
      expiresIn: "1 day",
    },
    {
      id: "expire-event-logs",
      prefix: "events/",
      expiresIn: isProduction(stage) ? "365 days" : "30 days",
    },
    {
      id: "expire-artifacts",
      prefix: "artifacts/",
      expiresIn: isProduction(stage) ? "365 days" : "30 days",
    },
  ];

  return rules;
}

export function getBucketConfig(stage: string) {
  return {
    lifecycle: getArtifactLifecycle(stage),
    versioning: isProduction(stage),
    enforceHttps: true,
  };
}
