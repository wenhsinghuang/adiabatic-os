import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "node:path";

export interface LamarckWebStackProps extends cdk.StackProps {
  stage: "dev" | "prod";
}

const prodApiDomainName = "api.lamarck.ai";

export class LamarckWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LamarckWebStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const appOrigin = process.env.LAMARCK_APP_ORIGIN || "https://app.lamarck.ai";
    const apiOrigin = process.env.LAMARCK_API_ORIGIN || "https://api.lamarck.ai";
    const secretName = `lamarck/${stage}/app`;

    const appSecret = secretsmanager.Secret.fromSecretNameV2(this, "AppSecret", secretName);

    const usersTable = new dynamodb.Table(this, "UsersTable", {
      tableName: `lamarck-${stage}-users`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: stage === "prod" },
      removalPolicy: stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const userIdentitiesTable = new dynamodb.Table(this, "UserIdentitiesTable", {
      tableName: `lamarck-${stage}-user-identities`,
      partitionKey: { name: "identityKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: stage === "prod" },
      removalPolicy: stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const connectionsTable = new dynamodb.Table(this, "ManagedProviderConnectionsTable", {
      tableName: `lamarck-${stage}-managed-provider-connections`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "providerId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: stage === "prod" },
      removalPolicy: stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const stateTable = new dynamodb.Table(this, "OAuthStateTable", {
      tableName: `lamarck-${stage}-oauth-state`,
      partitionKey: { name: "state", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: stage === "prod" },
      removalPolicy: stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const frontendOrigins = frontendOriginsFor(stage, appOrigin);
    const sharedEnv = {
      APP_ENV: stage,
      SECRET_NAME: secretName,
      LAMARCK_APP_ORIGIN: appOrigin,
      LAMARCK_API_ORIGIN: apiOrigin,
      LAMARCK_ALLOWED_ORIGINS: frontendOrigins.join(","),
      USERS_TABLE: usersTable.tableName,
      USER_IDENTITIES_TABLE: userIdentitiesTable.tableName,
      MANAGED_PROVIDER_CONNECTIONS_TABLE: connectionsTable.tableName,
      OAUTH_STATE_TABLE: stateTable.tableName,
    };

    const apiHandler = new lambdaNodejs.NodejsFunction(this, "ApiHandler", {
      functionName: `lamarck-${stage}-api-handler`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "src", "api", "handler.ts"),
      handler: "handler",
      depsLockFilePath: path.join(__dirname, "..", "..", "..", "package-lock.json"),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        format: lambdaNodejs.OutputFormat.CJS,
        target: "node22",
        minify: false,
        sourceMap: false,
      },
      environment: sharedEnv,
      logGroup: new logs.LogGroup(this, "ApiHandlerLogGroup", {
        logGroupName: `/aws/lambda/lamarck-${stage}-api-handler`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    appSecret.grantRead(apiHandler);
    usersTable.grantReadWriteData(apiHandler);
    usersTable.grant(apiHandler, "dynamodb:TransactWriteItems");
    userIdentitiesTable.grantReadWriteData(apiHandler);
    userIdentitiesTable.grant(apiHandler, "dynamodb:TransactWriteItems");
    connectionsTable.grantReadWriteData(apiHandler);
    stateTable.grantReadWriteData(apiHandler);

    const api = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: `lamarck-${stage}-api`,
      description: `Lamarck API (${stage})`,
      corsPreflight: corsFor(stage, frontendOrigins),
    });

    setDefaultThrottle(api, 50, 25);

    const apiIntegration = new integrations.HttpLambdaIntegration("ApiIntegration", apiHandler);

    api.addRoutes({
      path: "/healthz",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });
    api.addRoutes({
      path: "/me",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });
    api.addRoutes({
      path: "/providers/{providerId}/connect/start",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    api.addRoutes({
      path: "/providers/{providerId}/oauth/callback",
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    api.addRoutes({
      path: "/providers/{providerId}/{proxy+}",
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.PUT,
        apigatewayv2.HttpMethod.PATCH,
        apigatewayv2.HttpMethod.DELETE,
      ],
      integration: apiIntegration,
    });

    if (stage === "prod") {
      const apiCertificate = certificatemanager.Certificate.fromCertificateArn(
        this,
        "ApiCustomDomainCertificate",
        appSecret.secretValueFromJson("LAMARCK_API_CERTIFICATE_ARN").unsafeUnwrap(),
      );
      const apiDomain = new apigatewayv2.DomainName(this, "ApiCustomDomain", {
        domainName: prodApiDomainName,
        certificate: apiCertificate,
      });
      new apigatewayv2.ApiMapping(this, "ApiCustomDomainMapping", {
        api,
        domainName: apiDomain,
      });
      new cdk.CfnOutput(this, "ApiCustomDomainName", {
        value: prodApiDomainName,
        description: "Production API custom domain",
      });
      new cdk.CfnOutput(this, "ApiCustomDomainTarget", {
        value: apiDomain.regionalDomainName,
        description: "Create a Cloudflare CNAME from api.lamarck.ai to this target",
      });
    }

    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: api.apiEndpoint,
      description: "Lamarck HTTP API endpoint",
    });
    new cdk.CfnOutput(this, "ManagedProviderConnectionsTableName", {
      value: connectionsTable.tableName,
      description: "Managed provider connection table",
    });
    new cdk.CfnOutput(this, "UsersTableName", {
      value: usersTable.tableName,
      description: "Lazy Clerk-backed user table",
    });
    new cdk.CfnOutput(this, "UserIdentitiesTableName", {
      value: userIdentitiesTable.tableName,
      description: "External identity to Lamarck user mapping table",
    });
    new cdk.CfnOutput(this, "OAuthStateTableName", {
      value: stateTable.tableName,
      description: "OAuth/connect state table",
    });
    new cdk.CfnOutput(this, "SecretName", {
      value: secretName,
      description: "Secrets Manager bundle read by Lambda",
    });
  }
}

function corsFor(stage: "dev" | "prod", origins: string[]): apigatewayv2.CorsPreflightOptions {
  return {
    allowOrigins: origins,
    allowMethods: [
      apigatewayv2.CorsHttpMethod.GET,
      apigatewayv2.CorsHttpMethod.POST,
      apigatewayv2.CorsHttpMethod.PUT,
      apigatewayv2.CorsHttpMethod.PATCH,
      apigatewayv2.CorsHttpMethod.DELETE,
      apigatewayv2.CorsHttpMethod.OPTIONS,
    ],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    maxAge: cdk.Duration.hours(1),
  };
}

function frontendOriginsFor(stage: "dev" | "prod", ...origins: string[]): string[] {
  const localOrigins = [
    "http://localhost:32100",
    "http://localhost:32101",
    "http://localhost:32102",
    "http://localhost:5173",
    "http://localhost:8787",
  ];
  const workerOrigins = [
    "https://lamarck-app.adiabatic.workers.dev",
    "https://dev-lamarck-app.adiabatic.workers.dev",
  ];
  return Array.from(
    new Set(stage === "prod" ? origins : [...origins, ...workerOrigins, ...localOrigins]),
  );
}

function setDefaultThrottle(api: apigatewayv2.HttpApi, burstLimit: number, rateLimit: number): void {
  const stage = api.defaultStage?.node.defaultChild as apigatewayv2.CfnStage | undefined;
  if (!stage) {
    return;
  }
  stage.defaultRouteSettings = {
    throttlingBurstLimit: burstLimit,
    throttlingRateLimit: rateLimit,
  };
}
