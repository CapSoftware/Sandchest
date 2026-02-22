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
import {
  getNodeAmiSsmParameter,
  getNodeGrpcPort,
  getNodeInstanceType,
  getNodeRootVolumeGb,
  getNodeUserData,
} from "./infra/node";
import {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_OIDC_THUMBPRINTS,
  GITHUB_REPO,
  getDeployRoleName,
  getDeployRoleTrustPolicy,
} from "./infra/oidc";
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

    const node = new aws.ec2.Instance("NodeInstance", {
      ami: nodeAmi.value,
      instanceType: getNodeInstanceType($app.stage),
      subnetId: vpc.privateSubnets.apply((subs) => subs[0]),
      iamInstanceProfile: nodeProfile.name,
      vpcSecurityGroupIds: [nodeSg.id],
      rootBlockDevice: {
        volumeSize: getNodeRootVolumeGb(),
        volumeType: "gp3",
        encrypted: true,
      },
      metadataOptions: {
        httpEndpoint: "enabled",
        httpTokens: "required",
      },
      userData: getNodeUserData($app.stage),
      tags: { Name: `sandchest-node-${$app.stage}` },
    });

    // --- GitHub Actions OIDC ---

    const oidcProvider = new aws.iam.OpenIdConnectProvider("GitHubOidc", {
      url: GITHUB_OIDC_PROVIDER_URL,
      clientIdLists: [GITHUB_OIDC_AUDIENCE],
      thumbprintLists: GITHUB_OIDC_THUMBPRINTS,
    });

    const deployRole = new aws.iam.Role("DeployRole", {
      name: getDeployRoleName($app.stage),
      assumeRolePolicy: oidcProvider.arn.apply((arn) =>
        JSON.stringify(getDeployRoleTrustPolicy(arn, GITHUB_REPO)),
      ),
    });

    new aws.iam.RolePolicyAttachment("DeployAdminPolicy", {
      role: deployRole.name,
      policyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    });

    return {
      vpcId: vpc.id,
      redisHost: redis.host,
      redisPort: redis.port,
      artifactBucketName: artifactBucket.name,
      apiUrl: api.url,
      nodeInstanceId: node.id,
      nodePrivateIp: node.privateIp,
      deployRoleArn: deployRole.arn,
    };
  },
});
