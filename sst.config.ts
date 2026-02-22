/// <reference path="./.sst/platform/config.d.ts" />

import { getAppConfig } from "./infra/app";

export default $config({
  app(input) {
    return getAppConfig(input.stage);
  },
  async run() {
    // Infrastructure resources defined here and in infra/ modules
  },
});
