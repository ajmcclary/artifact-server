import * as pulumi from "@pulumi/pulumi";
import {Effect, Schema} from "effect";
import {beforeAll, describe, expect, test} from "vitest";

import {parseAwsPulumiConfiguration} from
  "../configuration.js";
import {defineAwsStack} from "../stack.js";
import {
  type AwsCloudDeploymentInput,
  type CloudDeploymentDocument,
  parseCloudDeploymentOutput,
} from "../../../../src/deployment/cloud-deployment-contract.js";

const digest = `sha256:${"a".repeat(64)}`;
const imageReference = `ghcr.io/ajmcclary/artifact-server@${digest}`;
const resources: pulumi.runtime.MockResourceArgs[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks({
    call: (args) => {
      if (args.token.includes("getAvailabilityZones")) {
        return {
          names: ["us-east-1a", "us-east-1b", "us-east-1c"],
          state: "available",
          zoneIds: ["use1-az1", "use1-az2", "use1-az3"],
        };
      }
      if (args.token.includes("getPartition")) {
        return {
          dnsSuffix: "amazonaws.com",
          partition: "aws",
          reverseDnsPrefix: "com.amazonaws",
        };
      }
      if (args.token.includes("getManagedPrefixList")) {
        return {
          ...args.inputs,
          id: "pl-3b927c5e",
          name: "com.amazonaws.global.cloudfront.origin-facing",
        };
      }
      if (args.token.includes("getVpc")) {
        return {...args.inputs, cidrBlock: "10.50.0.0/16"};
      }
      if (args.token.includes("getSubnet")) {
        const subnetId = String(args.inputs["id"]);
        return {
          ...args.inputs,
          availabilityZone: subnetId.endsWith("-a") ? "us-east-1a" : "us-east-1b",
          vpcId: subnetId.includes("wrong-vpc") ? "vpc-other" : "vpc-existing",
        };
      }
      return args.inputs;
    },
    newResource: (args) => {
      resources.push(args);
      return {
        id: `${args.name}-id`,
        state: mockResourceState(args),
      };
    },
  }, "artifact-server-aws", "production", false, "artifact-server");
});

describe("AWS Pulumi deployment", () => {
  test("derives the configured capacity plan and rejects unsafe combinations", () => {
    const configuration = parseAwsPulumiConfiguration(awsInput(), "production");

    expect(configuration.plan).toMatchObject({
      cpuUnits: 1_024,
      database: {
        instanceClass: "db.t4g.medium",
        multiAz: false,
      },
      desiredCount: 2,
      memoryMiB: 2_048,
      natGatewayCount: 2,
      maximumDatabaseConnections: 88,
    });
    expect(() => parseAwsPulumiConfiguration(awsInput({
      capacity: {
        cpu: 1,
        maximumInstances: 4,
        memoryMiB: 1_024,
        minimumInstances: 2,
      },
    }), "production")).toThrow("Fargate and RDS plans");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      capacity: {
        cpu: 1,
        maximumInstances: 5,
        memoryMiB: 2_048,
        minimumInstances: 2,
      },
      databasePlan: "small",
    }), "production")).toThrow("Fargate and RDS plans");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      capacity: {
        cpu: 1,
        maximumInstances: 30,
        memoryMiB: 2_048,
        minimumInstances: 2,
      },
    }), "production")).toThrow("Fargate and RDS plans");
  });

  test("rejects stack drift, incomplete network adoption, and private TLS ambiguity", () => {
    expect(() => parseAwsPulumiConfiguration(awsInput(), "staging"))
      .toThrow("active Pulumi stack");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      existingNetwork: {
        applicationSubnetIds: ["subnet-app-a", "subnet-app-b"],
        databaseSubnetIds: ["subnet-db-a", "subnet-db-b"],
        vpcId: "vpc-existing",
      },
    }), "production")).toThrow("shared cloud contract");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      ingress: "private",
    }), "production")).toThrow("shared cloud contract");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      ingress: "private",
      privateIngressCidrs: ["10.0.0.0/33"],
      tlsCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/private-artifacts",
    }), "production")).toThrow("shared cloud contract");
  });

  test("defines the secure AWS resource graph and exact shared outputs", async () => {
    resources.length = 0;
    const configuration = parseAwsPulumiConfiguration(awsInput({
      autoAdmitEmailDomains: ["example.org"],
    }), "production");
    const stackOutputs = await pulumi.runtime.runInPulumiStack(async () => {
      const stack = await defineAwsStack(configuration);
      return {deployment: stack.deployment};
    });
    const deployment = await Effect.runPromise(parseCloudDeploymentOutput(
      configuration.input,
      stackOutputs?.["deployment"] ?? null,
    ));

    const resourceTypes = resources.map((resource) => resource.type);
    expect(resourceTypes).toContain("aws:cloudfront/cachePolicy:CachePolicy");
    expect(resourceTypes).toContain("aws:cloudfront/distribution:Distribution");
    expect(resourceTypes).toContain("aws:ecs/service:Service");
    expect(resourceTypes).toContain("aws:rds/instance:Instance");
    expect(resourceTypes).toContain("aws:s3/bucket:Bucket");
    expect(resourceTypes).toContain("aws:lb/loadBalancer:LoadBalancer");
    expect(resourceTypes).toContain("aws:appautoscaling/target:Target");
    expect(resourceTypes).toContain("aws:cloudwatch/eventRule:EventRule");
    expect(resourceTypes).toContain("aws:cloudwatch/eventTarget:EventTarget");
    expect(resourceTypes.filter((type) => type === "aws:ec2/natGateway:NatGateway"))
      .toHaveLength(2);

    const database = requireResource("aws:rds/instance:Instance");
    expect(database.inputs).toMatchObject({
      backupRetentionPeriod: 14,
      deletionProtection: true,
      engineVersion: "17.10",
      publiclyAccessible: false,
      storageEncrypted: true,
    });
    expect(String(database.inputs["finalSnapshotIdentifier"]))
      .toMatch(/^as-[a-f0-9]{12}-final-[a-z0-9]{8}$/u);
    const publicAccessBlock = requireResource(
      "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock",
    );
    expect(publicAccessBlock.inputs).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    const bucket = requireResource("aws:s3/bucket:Bucket");
    expect(String(bucket.inputs["bucketPrefix"]).length).toBeLessThanOrEqual(37);
    const objectStoragePolicy = requireNamedResource(
      "aws:iam/rolePolicy:RolePolicy",
      "object-storage",
    );
    expect(String(objectStoragePolicy.inputs["policy"])).toContain(
      "s3:GetBucketLocation",
    );
    expect(String(objectStoragePolicy.inputs["policy"])).toContain("s3:DeleteObject");
    expect(String(objectStoragePolicy.inputs["policy"])).toContain("s3:DeleteObjectVersion");
    expect(String(objectStoragePolicy.inputs["policy"])).toContain("/staging/*");
    expect(String(objectStoragePolicy.inputs["policy"])).toContain(
      "s3:prefix",
    );
    const loadBalancer = requireResource("aws:lb/loadBalancer:LoadBalancer");
    expect(String(loadBalancer.inputs["name"]).length).toBeLessThanOrEqual(32);
    const targetGroup = requireResource("aws:lb/targetGroup:TargetGroup");
    expect(String(targetGroup.inputs["name"]).length).toBeLessThanOrEqual(32);
    const loadBalancerSecurityGroup = requireNamedResource(
      "aws:ec2/securityGroup:SecurityGroup",
      "load-balancer",
    );
    expect(loadBalancerSecurityGroup.inputs["ingress"]).toEqual([
      expect.objectContaining({prefixListIds: ["pl-3b927c5e"]}),
    ]);
    expect(JSON.stringify(loadBalancerSecurityGroup.inputs["ingress"]))
      .not.toContain("0.0.0.0/0");

    const cachePolicy = requireResource("aws:cloudfront/cachePolicy:CachePolicy");
    expect(cachePolicy.inputs).toMatchObject({
      defaultTtl: 0,
      maxTtl: 31_536_000,
      minTtl: 0,
      parametersInCacheKeyAndForwardedToOrigin: {
        cookiesConfig: {cookieBehavior: "none"},
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
        headersConfig: {
          headerBehavior: "whitelist",
          headers: {items: ["authorization", "host"]},
        },
        queryStringsConfig: {queryStringBehavior: "all"},
      },
    });
    const distribution = requireResource("aws:cloudfront/distribution:Distribution");
    expect(distribution.inputs["aliases"]).toEqual([
      "artifacts.example.com",
      "*.artifact-content.example.net",
    ]);
    expect(distribution.inputs["defaultCacheBehavior"]).toMatchObject({
      cachedMethods: ["GET", "HEAD"],
      compress: true,
      originRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3",
      viewerProtocolPolicy: "redirect-to-https",
    });
    // The origin carries the generated origin secret, so the engine stores the
    // whole input encrypted; decoding it proves it is a Pulumi secret.
    const origins = await Effect.runPromise(Schema.decodeUnknownEffect(
      pulumiSecret(Schema.Array(Schema.Struct({
        customHeaders: Schema.Array(Schema.Struct({name: Schema.String, value: Schema.String})),
        customOriginConfig: Schema.Struct({
          originProtocolPolicy: Schema.String,
          originReadTimeout: Schema.Number,
        }),
      }))),
    )(distribution.inputs["origins"]));
    expect(origins.value).toEqual([expect.objectContaining({
      customOriginConfig: {
        originProtocolPolicy: "https-only",
        originReadTimeout: 60,
      },
    })]);
    expect(distribution.inputs["viewerCertificate"]).toMatchObject({
      minimumProtocolVersion: "TLSv1.2_2021",
      sslSupportMethod: "sni-only",
    });
    const edgeProvider = requireNamedResource("pulumi:providers:aws", "us-east-1");
    expect(edgeProvider.inputs).toMatchObject({region: "us-east-1"});
    const edgeCertificate = requireNamedResource(
      "aws:acm/certificate:Certificate",
      "edge",
    );
    expect(edgeCertificate.inputs).toMatchObject({
      domainName: "artifacts.example.com",
      subjectAlternativeNames: ["*.artifact-content.example.net"],
      validationMethod: "DNS",
    });
    expect(edgeCertificate.provider).toContain("us-east-1");
    const aliasRecords = resources.filter((resource) =>
      resource.type === "aws:route53/record:Record" &&
      Array.isArray(resource.inputs["aliases"])
    );
    expect(aliasRecords).toHaveLength(2);
    for (const record of aliasRecords) {
      expect(record.inputs["aliases"]).toEqual([{
        evaluateTargetHealth: false,
        name: expect.stringContaining(".cloudfront.net"),
        zoneId: "Z2FDTNDATAQYW2",
      }]);
    }

    const taskDefinition = requireNamedResource(
      "aws:ecs/taskDefinition:TaskDefinition",
      "application",
    );
    const [container] = await Effect.runPromise(Schema.decodeUnknownEffect(
      Schema.Tuple([
        Schema.Struct({
          command: Schema.Array(Schema.String),
          environment: Schema.Array(Schema.Struct({name: Schema.String, value: Schema.String})),
          image: Schema.String,
          secrets: Schema.Array(Schema.Struct({name: Schema.String, valueFrom: Schema.String})),
        }),
        Schema.Unknown,
      ]),
    )(JSON.parse(String(taskDefinition.inputs["containerDefinitions"]))));
    expect(container).toBeDefined();
    expect(container?.image).toBe(imageReference);
    expect(container?.command.join(" ")).toContain("migrate apply");
    expect(container?.command.join(" ")).toContain("start-external-storage");
    expect(container?.environment).toContainEqual({
      name: "ARTIFACT_SERVER_STAGING_CLEANUP_SCHEDULE",
      value: "external",
    });
    expect(container?.environment).toContainEqual({
      name: "ARTIFACT_SERVER_AUTO_ADMIT_EMAIL_DOMAINS",
      value: "example.org",
    });
    expect(container?.environment).toContainEqual({
      name: "NODE_EXTRA_CA_CERTS",
      value: "/usr/local/share/ca-certificates/aws-rds-global-bundle.pem",
    });
    expect(container?.environment).toContainEqual({
      name: "ARTIFACT_SERVER_WORKOS_ISSUER",
      value: "https://artifact-server.authkit.example",
    });
    expect(container?.environment.map((entry) => entry.name)).not.toContain(
      "ARTIFACT_SERVER_S3_ACCESS_KEY_ID",
    );
    // Linked files are a local-only capability: the AWS task definition never
    // sets the switch, so the external-storage runtime can never enable it.
    expect(container?.environment.map((entry) => entry.name)).not.toContain(
      "ARTIFACT_SERVER_LINKED_FILES",
    );
    expect(container?.secrets.map((entry) => entry.name)).toEqual([
      "ARTIFACT_SERVER_API_TOKEN",
      "ARTIFACT_SERVER_DATABASE_URL",
      "ARTIFACT_SERVER_WORKOS_API_KEY",
    ]);
    expect(JSON.stringify(taskDefinition.inputs)).not.toContain(
      "generated-database-password",
    );
    expect(JSON.stringify(taskDefinition.inputs)).not.toContain(
      "generated-api-token",
    );
    const cleanupTaskDefinition = requireNamedResource(
      "aws:ecs/taskDefinition:TaskDefinition",
      "cleanup",
    );
    expect(String(cleanupTaskDefinition.inputs["containerDefinitions"]))
      .toContain("cleanup-staging");

    // Both task definitions run read-only with every capability dropped, and
    // write only to the task's ephemeral scratch volume.
    const hardenedDefinitions = await Promise.all(
      [taskDefinition, cleanupTaskDefinition].map(async (definition) => ({
        containers: await decodeHardenedContainers(definition),
        definition,
      })),
    );
    for (const {containers: [primary, preparation], definition} of hardenedDefinitions) {
      expect(primary).toMatchObject({
        dependsOn: [{condition: "SUCCESS", containerName: "prepare-scratch"}],
        essential: true,
        linuxParameters: {capabilities: {add: [], drop: ["ALL"]}, initProcessEnabled: true},
        mountPoints: [{containerPath: "/tmp", readOnly: false, sourceVolume: "scratch"}],
        readonlyRootFilesystem: true,
      });
      expect(primary?.user).toBeUndefined();
      expect(preparation).toMatchObject({
        command: ["chmod 1777 /tmp"],
        essential: false,
        linuxParameters: {capabilities: {add: [], drop: ["ALL"]}},
        mountPoints: [{containerPath: "/tmp", readOnly: false, sourceVolume: "scratch"}],
        name: "prepare-scratch",
        readonlyRootFilesystem: true,
        user: "0:0",
      });
      // The preparation step sees no secret and no application environment.
      expect(preparation?.secrets).toBeUndefined();
      expect(preparation?.environment).toBeUndefined();
      expect(definition.inputs["volumes"]).toEqual([{name: "scratch"}]);
    }

    // The cleanup job receives only storage and database settings.
    const cleanupContainer = hardenedDefinitions[1]?.containers[0];
    expect(cleanupContainer?.secrets?.map((entry) => entry.name)).toEqual([
      "ARTIFACT_SERVER_DATABASE_URL",
    ]);
    const cleanupEnvironmentNames =
      cleanupContainer?.environment?.map((entry) => entry.name) ?? [];
    for (const forbidden of [
      "ARTIFACT_SERVER_API_TOKEN",
      "ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL",
      "ARTIFACT_SERVER_ORIGIN",
      "ARTIFACT_SERVER_WORKOS_API_KEY",
      "ARTIFACT_SERVER_WORKOS_CLIENT_ID",
      "ARTIFACT_SERVER_WORKOS_ISSUER",
    ]) {
      expect(cleanupEnvironmentNames).not.toContain(forbidden);
    }
    expect(cleanupEnvironmentNames).toContain("ARTIFACT_SERVER_S3_BUCKET");
    expect(cleanupEnvironmentNames).toContain("ARTIFACT_SERVER_INSTALLATION_ID");
    const cleanupExecutionPolicy = requireNamedResource(
      "aws:iam/rolePolicy:RolePolicy",
      "cleanup-execution-secrets",
    );
    expect(String(cleanupExecutionPolicy.inputs["policy"])).toContain("database-url");
    expect(String(cleanupExecutionPolicy.inputs["policy"])).not.toContain("api-token");
    expect(String(cleanupExecutionPolicy.inputs["policy"])).not.toContain("workos");
    expect(String(cleanupTaskDefinition.inputs["executionRoleArn"]))
      .toContain("cleanup-execution");
    const cleanupSchedulePolicy = requireNamedResource(
      "aws:iam/rolePolicy:RolePolicy",
      "cleanup-schedule",
    );
    expect(String(cleanupSchedulePolicy.inputs["policy"])).toContain("cleanup-execution");
    expect(String(cleanupSchedulePolicy.inputs["policy"])).not.toContain(
      "production-execution",
    );

    // The load balancer refuses every request that lacks the distribution's
    // generated origin secret, so another CloudFront distribution cannot reach it.
    const listener = requireResource("aws:lb/listener:Listener");
    expect(listener.inputs["defaultActions"]).toEqual([expect.objectContaining({
      fixedResponse: expect.objectContaining({statusCode: "403"}),
      type: "fixed-response",
    })]);
    const verifiedOriginRule = requireResource("aws:lb/listenerRule:ListenerRule");
    expect(verifiedOriginRule.inputs).toMatchObject({
      actions: [expect.objectContaining({type: "forward"})],
      priority: 1,
    });
    const ruleConditions = await Effect.runPromise(Schema.decodeUnknownEffect(
      pulumiSecret(Schema.Array(Schema.Struct({
        httpHeader: Schema.Struct({
          httpHeaderName: Schema.String,
          values: Schema.Array(Schema.String),
        }),
      }))),
    )(verifiedOriginRule.inputs["conditions"]));
    expect(ruleConditions.value).toEqual([{
      httpHeader: {
        httpHeaderName: "X-Artifact-Server-Origin-Verify",
        values: ["generated-origin-secret"],
      },
    }]);
    expect(origins.value.map((origin) => origin.customHeaders)).toEqual([[{
      name: "X-Artifact-Server-Origin-Verify",
      value: "generated-origin-secret",
    }]]);
    for (const definition of [taskDefinition, cleanupTaskDefinition]) {
      expect(JSON.stringify(definition.inputs)).not.toContain("generated-origin-secret");
    }
    expect(requireResource("aws:cloudwatch/eventRule:EventRule").inputs)
      .toMatchObject({scheduleExpression: "rate(15 minutes)"});

    expect(deployment).toMatchObject({
      applicationUrl: "https://artifacts.example.com",
      contentDomain: "artifact-content.example.net",
      healthUrl: "https://artifacts.example.com/health",
      imageDigest: digest,
      mcpUrl: "https://artifacts.example.com/mcp",
      readinessUrl: "https://artifacts.example.com/ready",
      stateBackend: "s3://artifact-server-pulumi-state/aws-production",
    });
    expect(JSON.stringify(deployment)).not.toContain("generated-api-token");
    expect(JSON.stringify(deployment)).not.toContain("generated-origin-secret");
    expect(JSON.stringify(deployment)).not.toContain("generated-database-password");
  });

  test("adopts a private two-zone VPC without creating public infrastructure", async () => {
    resources.length = 0;
    const configuration = parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      existingNetwork: existingNetwork(),
      ingress: "private",
      privateIngressCidrs: ["172.16.0.0/12"],
      tlsCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/private-artifacts",
    }), "production");
    await pulumi.runtime.runInPulumiStack(async () => {
      const stack = await defineAwsStack(configuration);
      return {deployment: stack.deployment};
    });

    expect(resources.some((resource) => resource.type === "aws:ec2/vpc:Vpc"))
      .toBe(false);
    expect(resources.some((resource) => resource.type === "aws:ec2/natGateway:NatGateway"))
      .toBe(false);
    expect(resources.some((resource) => resource.type === "aws:acm/certificate:Certificate"))
      .toBe(false);
    expect(resources.some((resource) => resource.type === "aws:route53/record:Record"))
      .toBe(false);
    expect(resources.some((resource) =>
      resource.type === "aws:cloudfront/distribution:Distribution"
    )).toBe(false);
    expect(resources.some((resource) =>
      resource.type === "aws:cloudfront/cachePolicy:CachePolicy"
    )).toBe(false);
    expect(requireResource("aws:lb/loadBalancer:LoadBalancer").inputs["internal"])
      .toBe(true);
    // Without CloudFront there is no origin secret: the private listener forwards.
    expect(requireResource("aws:lb/listener:Listener").inputs["defaultActions"])
      .toEqual([expect.objectContaining({type: "forward"})]);
    expect(resources.some((resource) =>
      resource.type === "aws:lb/listenerRule:ListenerRule"
    )).toBe(false);
    expect(requireResource("aws:ec2/securityGroup:SecurityGroup").inputs["ingress"])
      .toEqual([expect.objectContaining({cidrBlocks: ["172.16.0.0/12"]})]);

    const invalidConfiguration = parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      existingNetwork: {
        ...existingNetwork(),
        applicationSubnetIds: ["subnet-wrong-vpc-a", "subnet-app-b"],
      },
      ingress: "private",
      tlsCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/private-artifacts",
    }), "production");
    await expect(defineAwsStack(invalidConfiguration)).rejects.toThrow(
      "application subnets must belong to vpc-existing",
    );
  });
});

function awsInput(
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  const document: CloudDeploymentDocument = {
    applicationDomain: "artifacts.example.com",
    backupRetentionDays: 14,
    bootstrapAdministratorEmail: "admin@example.com",
    capacity: {
      cpu: 1,
      maximumInstances: 4,
      memoryMiB: 2_048,
      minimumInstances: 2,
    },
    contentDomain: "artifact-content.example.net",
    databasePlan: "standard",
    deletionProtection: true,
    dnsZoneIds: {
      application: "zone-artifacts",
      content: "zone-content",
    },
    environment: "production",
    imageReference,
    ingress: "public",
    installationName: "team-artifacts",
    region: "us-east-1",
    secretsProvider: "awskms://alias/artifact-server",
    stackName: "production",
    stateBackendUrl: "s3://artifact-server-pulumi-state/aws-production",
    target: "aws",
    workosApiKeySecretRef:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:workos",
    workosClientId: "client_01",
    workosIssuer: "https://artifact-server.authkit.example",
    ...overrides,
  };
  if (overrides["dnsZoneIds"] !== null) return document;
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== "dnsZoneIds"),
  );
}

const hardenedContainerSchema = Schema.Struct({
  command: Schema.optional(Schema.Array(Schema.String)),
  dependsOn: Schema.optional(Schema.Array(Schema.Struct({
    condition: Schema.String,
    containerName: Schema.String,
  }))),
  environment: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String,
    value: Schema.String,
  }))),
  essential: Schema.Boolean,
  linuxParameters: Schema.Struct({
    capabilities: Schema.Struct({
      add: Schema.Array(Schema.String),
      drop: Schema.Array(Schema.String),
    }),
    initProcessEnabled: Schema.optional(Schema.Boolean),
  }),
  mountPoints: Schema.Array(Schema.Struct({
    containerPath: Schema.String,
    readOnly: Schema.Boolean,
    sourceVolume: Schema.String,
  })),
  name: Schema.String,
  readonlyRootFilesystem: Schema.Boolean,
  secrets: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String,
    valueFrom: Schema.String,
  }))),
  user: Schema.optional(Schema.String),
});

/** Pulumi's wire form of a secret value inside mocked resource inputs. */
function pulumiSecret<S extends Schema.Top>(value: S) {
  return Schema.Struct({
    "4dabf18193072939515e22adb298388d": Schema.Literal("1b47061264138c4ac30d75fd1eb44270"),
    value,
  });
}

function decodeHardenedContainers(definition: pulumi.runtime.MockResourceArgs) {
  return Effect.runPromise(Schema.decodeUnknownEffect(
    Schema.Array(hardenedContainerSchema),
  )(JSON.parse(String(definition.inputs["containerDefinitions"]))));
}

function requireResource(type: string): pulumi.runtime.MockResourceArgs {
  const resource = resources.find((candidate) => candidate.type === type);
  if (resource === undefined) {
    throw new Error(`Pulumi did not register ${type}.`);
  }
  return resource;
}

function requireNamedResource(
  type: string,
  nameFragment: string,
): pulumi.runtime.MockResourceArgs {
  const resource = resources.find((candidate) =>
    candidate.type === type && candidate.name.includes(nameFragment)
  );
  if (resource === undefined) {
    throw new Error(`Pulumi did not register ${type} containing ${nameFragment}.`);
  }
  return resource;
}

function existingNetwork(): NonNullable<AwsCloudDeploymentInput["existingNetwork"]> {
  return {
    applicationSubnetIds: ["subnet-app-a", "subnet-app-b"],
    databaseSubnetIds: ["subnet-db-a", "subnet-db-b"],
    loadBalancerSubnetIds: ["subnet-lb-a", "subnet-lb-b"],
    vpcId: "vpc-existing",
  };
}

function mockResourceState(
  args: pulumi.runtime.MockResourceArgs,
): pulumi.runtime.MockResourceResult["state"] {
  const base = {...args.inputs};
  const arn = `arn:aws:mock:us-east-1:123456789012:${args.name}`;
  if (args.type === "random:index/randomUuid4:RandomUuid4") {
    return {...base, result: "019c1111-2222-7333-8444-555555555555"};
  }
  if (args.type === "random:index/randomPassword:RandomPassword") {
    if (args.name.includes("origin-verification")) {
      return {...base, result: "generated-origin-secret"};
    }
    return {
      ...base,
      result: args.name.includes("database")
        ? "generated-database-password"
        : "generated-api-token",
    };
  }
  if (args.type === "random:index/randomString:RandomString") {
    return {...base, result: "a1b2c3d4"};
  }
  if (args.type === "aws:s3/bucket:Bucket") {
    return {...base, arn, bucket: `${args.name}-bucket`};
  }
  if (args.type === "aws:rds/instance:Instance") {
    return {...base, arn, endpoint: "database.internal:5432"};
  }
  if (args.type === "aws:acm/certificate:Certificate") {
    const alternativeNames = Array.isArray(args.inputs["subjectAlternativeNames"])
      ? args.inputs["subjectAlternativeNames"].map(String)
      : [];
    const domains = [String(args.inputs["domainName"]), ...alternativeNames];
    return {
      ...base,
      arn,
      domainValidationOptions: domains.map((domain, index) => ({
        domainName: domain,
        resourceRecordName: `_validation-${index}.${args.name}`,
        resourceRecordType: "CNAME",
        resourceRecordValue: "validation.acm.invalid",
      })),
    };
  }
  if (args.type === "aws:cloudfront/distribution:Distribution") {
    return {
      ...base,
      arn,
      domainName: `${args.name}.cloudfront.net`,
      hostedZoneId: "Z2FDTNDATAQYW2",
    };
  }
  if (args.type === "aws:route53/record:Record") {
    return {...base, fqdn: String(args.inputs["name"])};
  }
  if (args.type === "aws:acm/certificateValidation:CertificateValidation") {
    return {...base, certificateArn: args.inputs["certificateArn"]};
  }
  if (args.type === "aws:lb/loadBalancer:LoadBalancer") {
    return {
      ...base,
      arn,
      dnsName: `${args.name}.elb.amazonaws.com`,
      zoneId: "Z35SXDOTRQ7X7K",
    };
  }
  if (args.type === "aws:ecs/service:Service") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:ecs/cluster:Cluster") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
    return {...base, arn, name: `/artifact-server/${args.name}`};
  }
  if (args.type === "aws:iam/role:Role") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:secretsmanager/secret:Secret") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:ecs/taskDefinition:TaskDefinition") {
    return {...base, arn};
  }
  if (args.type === "aws:lb/listener:Listener") {
    return {...base, arn};
  }
  if (args.type === "aws:lb/targetGroup:TargetGroup") {
    return {...base, arn};
  }
  return base;
}
