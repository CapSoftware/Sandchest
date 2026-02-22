/// <reference path="./.sst/platform/config.d.ts" />

import { getAppConfig } from "./infra/app";
import { getBucketConfig } from "./infra/bucket";
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

    return {
      vpcId: vpc.id,
      redisHost: redis.host,
      redisPort: redis.port,
      artifactBucketName: artifactBucket.name,
    };
  },
});
