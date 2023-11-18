import * as cdk from 'aws-cdk-lib'
import * as asg from 'aws-cdk-lib/aws-applicationautoscaling'
import * as aws_iam from 'aws-cdk-lib/aws-iam'
import * as aws_lambda from 'aws-cdk-lib/aws-lambda'
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as aws_s3 from 'aws-cdk-lib/aws-s3'

import { Construct } from 'constructs'
import * as path from 'path'

export interface RoutingLambdaStackProps extends cdk.NestedStackProps {
  poolCacheBucket: aws_s3.Bucket
  poolCacheBucket2: aws_s3.Bucket
  poolCacheKey: string
  jsonRpcProviders: { [chainName: string]: string }
  tokenListCacheBucket: aws_s3.Bucket
  provisionedConcurrency: number
  ethGasStationInfoUrl: string
  tenderlyUser: string
  tenderlyProject: string
  tenderlyAccessKey: string
  chatbotSNSArn?: string
}
export class RoutingLambdaStack extends cdk.NestedStack {
  public readonly routingLambda: aws_lambda_nodejs.NodejsFunction
  public readonly routeToRatioLambda: aws_lambda_nodejs.NodejsFunction
  public readonly routingLambdaAlias: aws_lambda.Alias

  constructor(scope: Construct, name: string, props: RoutingLambdaStackProps) {
    super(scope, name, props)
    const {
      poolCacheBucket,
      poolCacheBucket2,
      poolCacheKey,
      jsonRpcProviders,
      tokenListCacheBucket,
      provisionedConcurrency,
      ethGasStationInfoUrl,
      tenderlyUser,
      tenderlyProject,
      tenderlyAccessKey,
    } = props

    const lambdaRole = new aws_iam.Role(this, 'RoutingLambdaRole', {
      assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLambdaInsightsExecutionRolePolicy'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    })
    poolCacheBucket.grantRead(lambdaRole)
    poolCacheBucket2.grantRead(lambdaRole)
    tokenListCacheBucket.grantRead(lambdaRole)

    const region = cdk.Stack.of(this).region

    this.routingLambda = new aws_lambda_nodejs.NodejsFunction(this, 'RoutingLambda2', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_14_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteHandler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 1024,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      description: 'Routing Lambda',
      environment: {
        VERSION: '3',
        NODE_OPTIONS: '--enable-source-maps',
        POOL_CACHE_BUCKET: poolCacheBucket.bucketName,
        POOL_CACHE_BUCKET_2: poolCacheBucket2.bucketName,
        POOL_CACHE_KEY: poolCacheKey,
        TOKEN_LIST_CACHE_BUCKET: tokenListCacheBucket.bucketName,
        ETH_GAS_STATION_INFO_URL: ethGasStationInfoUrl,
        TENDERLY_USER: tenderlyUser,
        TENDERLY_PROJECT: tenderlyProject,
        TENDERLY_ACCESS_KEY: tenderlyAccessKey,
        ...jsonRpcProviders,
      },
      layers: [
        aws_lambda.LayerVersion.fromLayerVersionArn(
          this,
          'InsightsLayer',
          `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`
        ),
      ],
      tracing: aws_lambda.Tracing.ACTIVE,
    })

    this.routeToRatioLambda = new aws_lambda_nodejs.NodejsFunction(this, 'RouteToRatioLambda2', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_14_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteToRatioHandler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 1024,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      description: 'Route to Ratio Lambda',
      environment: {
        VERSION: '3',
        NODE_OPTIONS: '--enable-source-maps',
        POOL_CACHE_BUCKET: poolCacheBucket.bucketName,
        POOL_CACHE_BUCKET_2: poolCacheBucket2.bucketName,
        POOL_CACHE_KEY: poolCacheKey,
        TOKEN_LIST_CACHE_BUCKET: tokenListCacheBucket.bucketName,
        ETH_GAS_STATION_INFO_URL: ethGasStationInfoUrl,
        ...jsonRpcProviders,
      },
      layers: [
        aws_lambda.LayerVersion.fromLayerVersionArn(
          this,
          'InsightsLayerSwapAndAdd',
          `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`
        ),
      ],
      tracing: aws_lambda.Tracing.ACTIVE,
    })


    const enableProvisionedConcurrency = provisionedConcurrency > 0

    this.routingLambdaAlias = new aws_lambda.Alias(this, 'RoutingLiveAlias', {
      aliasName: 'live',
      version: this.routingLambda.currentVersion,
      provisionedConcurrentExecutions: enableProvisionedConcurrency ? provisionedConcurrency : undefined,
    })

    if (enableProvisionedConcurrency) {
      const target = new asg.ScalableTarget(this, 'RoutingProvConcASG', {
        serviceNamespace: asg.ServiceNamespace.LAMBDA,
        maxCapacity: provisionedConcurrency * 5,
        minCapacity: provisionedConcurrency,
        resourceId: `function:${this.routingLambdaAlias.lambda.functionName}:${this.routingLambdaAlias.aliasName}`,
        scalableDimension: 'lambda:function:ProvisionedConcurrency',
      })

      target.node.addDependency(this.routingLambdaAlias)

      target.scaleToTrackMetric('RoutingProvConcTracking', {
        targetValue: 0.8,
        predefinedMetric: asg.PredefinedMetric.LAMBDA_PROVISIONED_CONCURRENCY_UTILIZATION,
      })
    }
  }
}
