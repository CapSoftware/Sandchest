export function getAppConfig(stage: string) {
  return {
    name: "sandchest",
    home: "aws",
    providers: {
      aws: {
        region: "us-east-1",
      },
    },
    removal: stage === "production" ? "retain" : "remove",
    protect: stage === "production",
  } as const;
}
