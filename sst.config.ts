/// <reference path="./.sst/platform/config.d.ts" />

import { getAppConfig } from "./infra/app";
import { getBucketConfig } from "./infra/bucket";
import {
  getServiceCpu,
  getServiceEnvironment,
  getServiceHealthCheck,
  getServiceMemory,
  getServicePort,
  getServiceScaling,
} from "./infra/cluster";
import { getRedisConfig } from "./infra/redis";
import { getVpcConfig } from "./infra/vpc";

export default $config({
  app(input) {
    return getAppConfig(input.stage);
  },
  async run() {
    const vpc = new sst.aws.Vpc("Vpc", getVpcConfig($app.stage));
    const redis = new sst.aws.Redis(
      "Redis",
      getRedisConfig($app.stage, vpc),
    );
    const artifactBucket = new sst.aws.Bucket(
      "ArtifactBucket",
      getBucketConfig($app.stage),
    );

    const databaseUrl = new sst.Secret("DatabaseUrl");
    const betterAuthSecret = new sst.Secret("BetterAuthSecret");
    const resendApiKey = new sst.Secret("ResendApiKey");
    const autumnSecretKey = new sst.Secret("AutumnSecretKey");

    const cluster = new sst.aws.Cluster("Cluster", { vpc });
    const api = cluster.addService("Api", {
      cpu: getServiceCpu($app.stage),
      memory: getServiceMemory($app.stage),
      scaling: getServiceScaling($app.stage),
      health: getServiceHealthCheck(),
      public: { ports: [getServicePort()] },
      image: { dockerfile: "apps/api/Dockerfile", context: "." },
      link: [redis, artifactBucket],
      environment: {
        ...getServiceEnvironment($app.stage),
        REDIS_URL: $interpolate`redis://${redis.host}:${redis.port}`,
        DATABASE_URL: databaseUrl.value,
        BETTER_AUTH_SECRET: betterAuthSecret.value,
        RESEND_API_KEY: resendApiKey.value,
        AUTUMN_SECRET_KEY: autumnSecretKey.value,
      },
    });

    return {
      vpcId: vpc.id,
      redisHost: redis.host,
      redisPort: redis.port,
      artifactBucketName: artifactBucket.name,
      apiUrl: api.url,
    };
  },
});
