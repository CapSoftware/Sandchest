/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  async app(input) {
    const { getAppConfig } = await import("./infra/app");
    return getAppConfig(input.stage);
  },
  async run() {
    const { getVpcConfig } = await import("./infra/vpc");
    const { getRedisConfig, getRedisCacheClusterSuffix } = await import(
      "./infra/redis"
    );
    const { getBucketConfig } = await import("./infra/bucket");
    const {
      getServiceCpu,
      getServiceDomain,
      getServiceEnvironment,
      getLoadBalancerHealthCheck,
      getServiceMemory,
      getServiceRules,
      getServiceScaling,
    } = await import("./infra/cluster");
    const {
      getNodeAmiSsmParameter,
      getNodeAsgConfig,
      getNodeGrpcPort,
      getNodeLaunchTemplateConfig,
      getNodeUserData,
    } = await import("./infra/node");
    const {
      GITHUB_OIDC_AUDIENCE,
      GITHUB_OIDC_PROVIDER_URL,
      GITHUB_OIDC_THUMBPRINTS,
      GITHUB_REPO,
      getDeployRoleName,
      getDeployRoleTrustPolicy,
    } = await import("./infra/oidc");
    const {
      getAlb5xxAlarm,
      getAlbResponseTimeAlarm,
      getEcsCpuAlarm,
      getEcsMemoryAlarm,
      getEcsRunningTaskAlarm,
      getNodeAsgAlarm,
      getNodeHeartbeatAlarm,
      getRedisEvictionAlarm,
      getRedisMemoryAlarm,
      getSnsTopicName,
      NODE_HEARTBEAT_NAMESPACE,
    } = await import("./infra/alarms");
    type MetricAlarmConfig = import("./infra/alarms").MetricAlarmConfig;

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
    const api = new sst.aws.Service("Api", {
      cluster,
      cpu: getServiceCpu($app.stage),
      memory: getServiceMemory($app.stage),
      scaling: getServiceScaling($app.stage),
      loadBalancer: {
        domain: getServiceDomain($app.stage),
        rules: [...getServiceRules()],
        health: getLoadBalancerHealthCheck(),
      },
      image: { dockerfile: "apps/api/Dockerfile", context: "." },
      link: [
        redis,
        artifactBucket,
        databaseUrl,
        betterAuthSecret,
        resendApiKey,
        autumnSecretKey,
      ],
      environment: getServiceEnvironment($app.stage),
    });

    // --- Node Daemon (Firecracker host) ---

    const nodeAmi = await aws.ssm.getParameter({
      name: getNodeAmiSsmParameter(),
    });

    const nodeRole = new aws.iam.Role("NodeRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    new aws.iam.RolePolicyAttachment("NodeSsmPolicy", {
      role: nodeRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    });

    new aws.iam.RolePolicy("NodeS3Policy", {
      role: nodeRole.id,
      policy: artifactBucket.name.apply((name) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
              Resource: [
                `arn:aws:s3:::${name}`,
                `arn:aws:s3:::${name}/*`,
              ],
            },
          ],
        }),
      ),
    });

    const nodeProfile = new aws.iam.InstanceProfile("NodeProfile", {
      role: nodeRole.name,
    });

    const nodeSg = new aws.ec2.SecurityGroup("NodeSg", {
      vpcId: vpc.id,
      description: "Sandchest node daemon",
      ingress: [
        {
          description: "gRPC from VPC",
          fromPort: getNodeGrpcPort(),
          toPort: getNodeGrpcPort(),
          protocol: "tcp",
          cidrBlocks: [vpc.nodes.vpc.cidrBlock],
        },
      ],
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
        },
      ],
      tags: { Name: `sandchest-node-${$app.stage}` },
    });

    const ltConfig = getNodeLaunchTemplateConfig($app.stage);
    const nodeLt = new aws.ec2.LaunchTemplate("NodeLaunchTemplate", {
      imageId: nodeAmi.value,
      instanceType: ltConfig.instanceType,
      iamInstanceProfile: { name: nodeProfile.name },
      vpcSecurityGroupIds: [nodeSg.id],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pulumi v6.66.2 LaunchTemplateCpuOptions lacks nestedVirtualization field; remove cast once provider is updated
      cpuOptions: ltConfig.cpuOptions as any,
      blockDeviceMappings: [
        {
          deviceName: "/dev/xvda",
          ebs: {
            volumeSize: ltConfig.rootVolumeGb,
            volumeType: "gp3",
            encrypted: "true",
          },
        },
      ],
      metadataOptions: ltConfig.metadataOptions,
      userData: artifactBucket.name.apply((name) =>
        Buffer.from(getNodeUserData($app.stage, name)).toString("base64"),
      ),
      tagSpecifications: [
        {
          resourceType: "instance",
          tags: { Name: `sandchest-node-${$app.stage}` },
        },
      ],
    });

    const asgConfig = getNodeAsgConfig();
    const nodeAsg = new aws.autoscaling.Group("NodeAsg", {
      launchTemplate: {
        id: nodeLt.id,
        version: "$Latest",
      },
      vpcZoneIdentifiers: vpc.privateSubnets,
      minSize: asgConfig.minSize,
      maxSize: asgConfig.maxSize,
      desiredCapacity: asgConfig.desiredCapacity,
      healthCheckType: asgConfig.healthCheckType,
      healthCheckGracePeriod: asgConfig.healthCheckGracePeriod,
      defaultCooldown: asgConfig.defaultCooldown,
      tags: [
        {
          key: "Name",
          value: `sandchest-node-${$app.stage}`,
          propagateAtLaunch: true,
        },
      ],
    });

    // --- GitHub Actions OIDC ---

    const oidcProvider = new aws.iam.OpenIdConnectProvider("GitHubOidc", {
      url: GITHUB_OIDC_PROVIDER_URL,
      clientIdLists: [GITHUB_OIDC_AUDIENCE],
      thumbprintLists: GITHUB_OIDC_THUMBPRINTS,
    });

    const { isProduction } = await import("./infra/vpc");
    const allowedRefs = isProduction($app.stage)
      ? ["ref:refs/heads/main"]
      : undefined;

    const deployRole = new aws.iam.Role("DeployRole", {
      name: getDeployRoleName($app.stage),
      assumeRolePolicy: oidcProvider.arn.apply((arn) =>
        JSON.stringify(
          getDeployRoleTrustPolicy(arn, GITHUB_REPO, allowedRefs),
        ),
      ),
    });

    new aws.iam.RolePolicyAttachment("DeployAdminPolicy", {
      role: deployRole.name,
      policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    });

    // --- CloudWatch Alarms ---

    const alarmTopic = new aws.sns.Topic("AlarmTopic", {
      name: getSnsTopicName($app.stage),
    });

    function createAlarm(
      name: string,
      config: MetricAlarmConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pulumi Output values
      dimensions: Record<string, any>,
    ) {
      return new aws.cloudwatch.MetricAlarm(name, {
        alarmDescription: config.description,
        namespace: config.namespace,
        metricName: config.metricName,
        statistic: config.statistic,
        period: config.period,
        evaluationPeriods: config.evaluationPeriods,
        threshold: config.threshold,
        comparisonOperator: config.comparisonOperator,
        treatMissingData: config.treatMissingData,
        dimensions,
        alarmActions: [alarmTopic.arn],
        okActions: [alarmTopic.arn],
      });
    }

    const ecsClusterName = cluster.nodes.cluster.name;
    const ecsServiceName = api.nodes.service.name;

    createAlarm(
      "EcsRunningTaskAlarm",
      getEcsRunningTaskAlarm($app.stage),
      { ClusterName: ecsClusterName, ServiceName: ecsServiceName },
    );

    createAlarm(
      "EcsCpuAlarm",
      getEcsCpuAlarm($app.stage),
      { ClusterName: ecsClusterName, ServiceName: ecsServiceName },
    );

    createAlarm(
      "EcsMemoryAlarm",
      getEcsMemoryAlarm($app.stage),
      { ClusterName: ecsClusterName, ServiceName: ecsServiceName },
    );

    const albArnSuffix = api.nodes.loadBalancer.arnSuffix;

    createAlarm(
      "Alb5xxAlarm",
      getAlb5xxAlarm($app.stage),
      { LoadBalancer: albArnSuffix },
    );

    createAlarm(
      "AlbResponseTimeAlarm",
      getAlbResponseTimeAlarm($app.stage),
      { LoadBalancer: albArnSuffix },
    );

    const redisCacheClusterId = redis.clusterId.apply(
      (id) => `${id}${getRedisCacheClusterSuffix()}`,
    );

    createAlarm(
      "RedisMemoryAlarm",
      getRedisMemoryAlarm($app.stage),
      { CacheClusterId: redisCacheClusterId },
    );

    createAlarm(
      "RedisEvictionAlarm",
      getRedisEvictionAlarm($app.stage),
      { CacheClusterId: redisCacheClusterId },
    );

    createAlarm(
      "NodeHeartbeatAlarm",
      getNodeHeartbeatAlarm(),
      {},
    );

    createAlarm(
      "NodeAsgAlarm",
      getNodeAsgAlarm(),
      { AutoScalingGroupName: nodeAsg.name },
    );

    // Allow node daemon to publish heartbeat metrics
    new aws.iam.RolePolicy("NodeCloudWatchPolicy", {
      role: nodeRole.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "cloudwatch:PutMetricData",
            Resource: "*",
            Condition: {
              StringEquals: {
                "cloudwatch:namespace": NODE_HEARTBEAT_NAMESPACE,
              },
            },
          },
        ],
      }),
    });

    return {
      vpcId: vpc.id,
      redisHost: redis.host,
      redisPort: redis.port,
      artifactBucketName: artifactBucket.name,
      apiUrl: api.url,
      nodeAsgName: nodeAsg.name,
      deployRoleArn: deployRole.arn,
      alarmTopicArn: alarmTopic.arn,
    };
  },
});
