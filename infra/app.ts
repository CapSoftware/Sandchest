export function getAppConfig(stage: string) {
  return {
    name: "sandchest",
    home: "aws" as const,
    providers: {
      aws: {
        region: "us-east-1",
      },
    },
    removal: stage === "production" ? ("retain" as const) : ("remove" as const),
    protect: stage === "production",
  };
}
