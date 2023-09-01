import { ChainId} from '@orbitalapes/smart-order-router'
import * as cdk from 'aws-cdk-lib'
import { CfnOutput } from 'aws-cdk-lib'
import * as aws_apigateway from 'aws-cdk-lib/aws-apigateway'
import * as aws_waf from 'aws-cdk-lib/aws-wafv2'
import { Construct } from 'constructs'
import { RoutingCachingStack } from './routing-caching-stack'
import { RoutingLambdaStack } from './routing-lambda-stack'

export const CHAINS_NOT_MONITORED: ChainId[] = [
  ChainId.RINKEBY,
  ChainId.ARBITRUM_RINKEBY,
  ChainId.ROPSTEN,
  ChainId.KOVAN,
  ChainId.OPTIMISTIC_KOVAN,
  ChainId.GÖRLI,
  ChainId.POLYGON_MUMBAI,
]

export class RoutingAPIStack extends cdk.Stack {
  public readonly url: CfnOutput

  constructor(
    parent: Construct,
    name: string,
    props: cdk.StackProps & {
      jsonRpcProviders: { [chainName: string]: string }
      provisionedConcurrency: number
      throttlingOverride?: string
      ethGasStationInfoUrl: string
      chatbotSNSArn?: string
      stage: string
      route53Arn?: string
      pinata_key?: string
      pinata_secret?: string
      hosted_zone?: string
      tenderlyUser: string
      tenderlyProject: string
      tenderlyAccessKey: string
    }
  ) {
    super(parent, name, props)

    const {
      jsonRpcProviders,
      provisionedConcurrency,
      throttlingOverride,
      ethGasStationInfoUrl,
      chatbotSNSArn,
      stage,
      route53Arn,
      pinata_key,
      pinata_secret,
      hosted_zone,
      tenderlyUser,
      tenderlyProject,
      tenderlyAccessKey,
    } = props

    const {
      poolCacheBucket,
      poolCacheBucket2,
      poolCacheKey,
      tokenListCacheBucket,
    } = new RoutingCachingStack(this, 'RoutingCachingStack', {
      chatbotSNSArn,
      stage,
      route53Arn,
      pinata_key,
      pinata_secret,
      hosted_zone,
    })

    const {routingLambdaAlias, routeToRatioLambda } = new RoutingLambdaStack(
      this,
      'RoutingLambdaStack',
      {
        poolCacheBucket,
        poolCacheBucket2,
        poolCacheKey,
        jsonRpcProviders,
        tokenListCacheBucket,
        provisionedConcurrency,
        ethGasStationInfoUrl,
        chatbotSNSArn,
        tenderlyUser,
        tenderlyProject,
        tenderlyAccessKey,
      }
    )

    

    const api = new aws_apigateway.RestApi(this, 'routing-api', {
      restApiName: 'Routing API',
      defaultCorsPreflightOptions: {
        allowOrigins: ["https://forge.trade"],
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    })

    const ipThrottlingACL = new aws_waf.CfnWebACL(this, 'RoutingAPIIPThrottlingACL', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'RoutingAPIIPBasedThrottling',
      },
      customResponseBodies: {
        RoutingAPIThrottledResponseBody: {
          contentType: 'APPLICATION_JSON',
          content: '{"errorCode": "TOO_MANY_REQUESTS"}',
        },
      },
      name: 'RoutingAPIIPThrottling',
      rules: [
        {
          name: 'ip',
          priority: 0,
          statement: {
            rateBasedStatement: {
              // Limit is per 5 mins, i.e. 120 requests every 5 mins
              limit: throttlingOverride ? parseInt(throttlingOverride) : 120,
              // API is of type EDGE so is fronted by Cloudfront as a proxy.
              // Use the ip set in X-Forwarded-For by Cloudfront, not the regular IP
              // which would just resolve to Cloudfronts IP.
              aggregateKeyType: 'FORWARDED_IP',
              forwardedIpConfig: {
                headerName: 'X-Forwarded-For',
                fallbackBehavior: 'MATCH',
              },
            },
          },
          action: {
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: 'RoutingAPIThrottledResponseBody',
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RoutingAPIIPBasedThrottlingRule',
          },
        },
      ],
    })

    const region = cdk.Stack.of(this).region
    const apiArn = `arn:aws:apigateway:${region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`

    new aws_waf.CfnWebACLAssociation(this, 'RoutingAPIIPThrottlingAssociation', {
      resourceArn: apiArn,
      webAclArn: ipThrottlingACL.getAtt('Arn').toString(),
    })

    const lambdaIntegration = new aws_apigateway.LambdaIntegration(routingLambdaAlias)

    const quote = api.root.addResource('quote', {
      defaultCorsPreflightOptions: {
        allowOrigins: ["https://forge.trade"],
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    })
    quote.addMethod('GET', lambdaIntegration)

    const routeToRatioLambdaIntegration = new aws_apigateway.LambdaIntegration(routeToRatioLambda)

    const quoteToRatio = api.root.addResource('quoteToRatio', {
      defaultCorsPreflightOptions: {
        allowOrigins: ["https://forge.trade"],
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    })
    quoteToRatio.addMethod('GET', routeToRatioLambdaIntegration)

    this.url = new CfnOutput(this, 'Url', {
      value: api.url,
    })
  }
}
