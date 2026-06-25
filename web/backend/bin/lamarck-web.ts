#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LamarckWebStack } from "../lib/lamarck-web-stack";

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;
const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || "us-west-2";

new LamarckWebStack(app, "LamarckDevStack", {
  stage: "dev",
  env: { account, region },
});

new LamarckWebStack(app, "LamarckProdStack", {
  stage: "prod",
  env: { account, region },
});
