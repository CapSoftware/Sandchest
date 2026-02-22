/// <reference path="./.sst/platform/config.d.ts" />

import { getAppConfig } from "./infra/app";
import { getVpcConfig } from "./infra/vpc";

export default $config({
  app(input) {
    return getAppConfig(input.stage);
  },
  async run() {
    const vpc = new sst.aws.Vpc("Vpc", getVpcConfig($app.stage));

    return { vpcId: vpc.id };
  },
});
