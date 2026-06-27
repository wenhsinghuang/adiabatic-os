import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "node:path";

export interface LamarckWebStackProps extends cdk.StackProps {
  stage: "dev" | "prod";
}

const lambdaRoot = path.join(__dirname, "..", "lambda");
const prodApiDomainName = "api.lamarck.ai";

export class LamarckWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LamarckWebStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const appOrigin = process.env.LAMARCK_APP_ORIGIN || "https://app.lamarck.ai";
    const apiOrigin = process.env.LAMARCK_API_ORIGIN || "https://api.lamarck.ai";
    const apiCertificateArn = process.env.LAMARCK_API_CERTIFICATE_ARN;
    const secretName = `lamarck/${stage}/app`;

    const appSecret = secretsmanager.Secret.fromSecretNameV2(this, "AppSecret", secretName);

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

    const sharedEnv = {
      APP_ENV: stage,
      SECRET_NAME: secretName,
      LAMARCK_APP_ORIGIN: appOrigin,
      LAMARCK_API_ORIGIN: apiOrigin,
      MANAGED_PROVIDER_CONNECTIONS_TABLE: connectionsTable.tableName,
      OAUTH_STATE_TABLE: stateTable.tableName,
    };

    const apiHandler = new lambda.Function(this, "ApiHandler", {
      functionName: `lamarck-${stage}-api-handler`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(lambdaRoot, "api")),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: sharedEnv,
      logGroup: new logs.LogGroup(this, "ApiHandlerLogGroup", {
        logGroupName: `/aws/lambda/lamarck-${stage}-api-handler`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    appSecret.grantRead(apiHandler);
    connectionsTable.grantReadWriteData(apiHandler);
    stateTable.grantReadWriteData(apiHandler);

    const api = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: `lamarck-${stage}-api`,
      description: `Lamarck API (${stage})`,
      corsPreflight: corsFor(stage, [appOrigin]),
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

    if (stage === "prod" && apiCertificateArn) {
      const apiCertificate = certificatemanager.Certificate.fromCertificateArn(
        this,
        "ApiCustomDomainCertificate",
        apiCertificateArn,
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
  const localOrigins = [
    "http://localhost:32100",
    "http://localhost:32101",
    "http://localhost:32102",
    "http://localhost:5173",
  ];
  return {
    allowOrigins: stage === "prod" ? origins : [...origins, ...localOrigins],
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
