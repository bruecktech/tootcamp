import {Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {SubnetType} from 'aws-cdk-lib/aws-ec2';
import * as elastic from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as os from 'aws-cdk-lib/aws-opensearchservice';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {ApplicationProtocol} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as certificateManager from 'aws-cdk-lib/aws-certificatemanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import {Platform} from "aws-cdk-lib/aws-ecr-assets";
import {SesSmtpCredentials} from "@pepperize/cdk-ses-smtp-credentials";
import {AnyPrincipal, Effect, PolicyStatement, User} from "aws-cdk-lib/aws-iam";
import {EngineVersion} from "aws-cdk-lib/aws-opensearchservice";

export interface MastodonStackProps extends StackProps {
    domain: string,
    smtpFromAddress: string,
}

export class MastodonStack extends Stack {

    constructor(scope: Construct, id: string, props: MastodonStackProps) {
        super(scope, id, props);

        // Network to run everything in
        const vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 3,
            subnetConfiguration: [
                {
                    cidrMask: 19,
                    name: 'public',
                    subnetType: SubnetType.PUBLIC,
                }
            ]
        });

        // Define a group for telling Elasticache which subnets to put cache nodes in.
        const redisSubnetGroup = new elastic.CfnSubnetGroup(this, `SubnetGroup`, {
            description: `List of subnets used for redis cache ${id}`,
            subnetIds: vpc.publicSubnets.map(subnet => subnet.subnetId),
        });

        // The security group that defines network level access to the cluster
        const redisSecurityGroup = new ec2.SecurityGroup(this, `RedisSecurityGroup`, {vpc: vpc});

        const redisConnections = new ec2.Connections({
            securityGroups: [redisSecurityGroup],
            defaultPort: ec2.Port.tcp(6379),
        });

        // The cluster resource itself.
        const redisCluster = new elastic.CfnCacheCluster(this, 'RedisCluster', {
            cacheNodeType: 'cache.t4g.micro',
            engine: 'redis',
            numCacheNodes: 1,
            autoMinorVersionUpgrade: true,
            cacheSubnetGroupName: redisSubnetGroup.ref,
            vpcSecurityGroupIds: [
                redisSecurityGroup.securityGroupId,
            ]
        });

        // The security group that defines network level access to the cluster
        const rdsSecurityGroup = new ec2.SecurityGroup(this, `RdsSecurityGroup`, {vpc: vpc});

        const rdsSubnetGroup = new rds.CfnDBSubnetGroup(this, `RdsSubnetGroup`, {
            subnetIds: vpc.publicSubnets.map(subnet => subnet.subnetId),
            dbSubnetGroupDescription: "Subnet for the PostgresDB"
        });

        const rdsConnections = new ec2.Connections({
            securityGroups: [rdsSecurityGroup],
            defaultPort: ec2.Port.tcp(5432),
        });

        const db = new rds.CfnDBInstance(this, 'DbInstance', {
            engine: rds.DatabaseInstanceEngine.POSTGRES.engineType,
            engineVersion: '13.7',
            autoMinorVersionUpgrade: true,
            allowMajorVersionUpgrade: false,
            multiAz: true,
            dbInstanceClass: 'db.t4g.micro',
            storageType: 'gp2',
            allocatedStorage: '10',
            dbName: 'mastodon',
            masterUserPassword: 'mastodon',
            masterUsername: 'mastodon',
            vpcSecurityGroups: [rdsSecurityGroup.securityGroupId],
            dbSubnetGroupName: rdsSubnetGroup.ref,
        })

        // The security group that defines network level access to the cluster
        const esSecurityGroup = new ec2.SecurityGroup(this, `EsSecurityGroup`, {vpc: vpc});

        const esConnections = new ec2.Connections({
            securityGroups: [esSecurityGroup],
            defaultPort: ec2.Port.tcp(80)
        });

        const esDomain = new os.Domain(this, 'EsDomain', {
            version: EngineVersion.OPENSEARCH_1_3,
            enableVersionUpgrade: true,
            vpc: vpc,
            vpcSubnets: [{
                subnets: [vpc.publicSubnets[0]],
            }],
            securityGroups: [esSecurityGroup],
            capacity: {
                dataNodes: 1,
                dataNodeInstanceType: 't3.small.search',
            },
            ebs: {
                volumeSize: 10,
                volumeType: ec2.EbsDeviceVolumeType.GENERAL_PURPOSE_SSD,
            },
            accessPolicies: [
                new PolicyStatement({
                    actions: ['es:ESHttpPost*', 'es:ESHttpPut*'],
                    effect: Effect.ALLOW,
                    principals: [new AnyPrincipal()],
                    resources: ['*'],
                }),
            ]
        })

        const s3Bucket = new s3.Bucket(this, 'S3Bucket', {
            publicReadAccess: true
        });

        const ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc: vpc,
        });

        const zone = route53.PublicHostedZone.fromLookup(this, 'Route53Zone', {
            domainName: props.domain
        });

        const user = new User(this, "SesUser", {
            userName: "ses-user",
        });

        const smtpCredentials = new SesSmtpCredentials(this, "SmtpCredentials", {
            user: user,
        });

        const environment = {
            DB_HOST: db.attrEndpointAddress,
            DB_PORT: db.attrEndpointPort,
            LOCAL_DOMAIN: props.domain,
            STREAMING_API_BASE_URL: 'mastodon-stream.' + props.domain,
            DB_PASS: 'mastodon', // TODO fix this
            DB_USER: 'mastodon',
            DB_NAME: 'mastodon',
            REDIS_HOST: redisCluster.attrRedisEndpointAddress,
            REDIS_PORT: redisCluster.attrRedisEndpointPort,
            SECRET_KEY_BASE: '<REDACTED>',
            OTP_SECRET: '<REDACTED>',
            S3_ENABLED: 'true',
            S3_BUCKET: s3Bucket.bucketName,
            S3_REGION: props.env?.region || 'eu-central-1',
            ES_ENABLED: 'true',
            ES_HOST: esDomain.domainEndpoint,
            ES_PORT: '80',
            SMTP_SERVER: 'email-smtp.' + props.env?.region || 'eu-central-1' + '.amazonaws.com',
            SMTP_PORT: '587',
            SMTP_FROM_ADDRESS: props.smtpFromAddress,
            VAPID_PRIVATE_KEY: '<REDACTED>',
            VAPID_PUBLIC_KEY: '<REDACTED>'
        };

        const secrets = {
            SMTP_LOGIN: ecs.Secret.fromSecretsManager(smtpCredentials.secret, "username"),
            SMTP_PASSWORD: ecs.Secret.fromSecretsManager(smtpCredentials.secret, "password"),
        }

        const image = ecs.ContainerImage.fromAsset('.', {
            platform: Platform.LINUX_AMD64
        })
        //const image = ecs.ContainerImage.fromRegistry('tootsuite/mastodon:4.0.0rc2')

        const webTaskDefinition = new ecs.FargateTaskDefinition(this, 'WebTask');

        const web = new ecs.ContainerDefinition(this, "web", {
            taskDefinition: webTaskDefinition,
            image: image,
            environment: environment,
            secrets: secrets,
            command: ["bash", "-c", "bundle exec rake db:migrate; bundle exec rails s -p 3000 -b '0.0.0.0'"],
            logging: new ecs.AwsLogDriver({
                streamPrefix: 'web'
            })
        });

        web.addPortMappings({
            containerPort: 3000,
            protocol: ecs.Protocol.TCP,
        });

        const webService = new ecs.FargateService(this, 'WebService', {
            taskDefinition: webTaskDefinition,
            cluster: ecsCluster,
            assignPublicIp: true,
        });

        const webLoadBalancer = new elbv2.ApplicationLoadBalancer(this, 'WebLoadBalancer', {
            vpc: vpc,
            internetFacing: true,
        });

        webLoadBalancer.addRedirect({
            sourceProtocol: ApplicationProtocol.HTTP,
            targetProtocol: ApplicationProtocol.HTTPS,
        });

        const webListener = webLoadBalancer.addListener('Listener', {port: 443});
        webListener.addTargets('webService', {
            port: 3000,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [webService],
            healthCheck: {
                path: '/health',
            }
        });

        const webCert = new certificateManager.DnsValidatedCertificate(this, 'WebCert', {
            hostedZone: zone,
            domainName: props.domain
        });

        new route53.ARecord(this, "WebRecord", {
            zone,
            target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(webLoadBalancer)),
        });

        webListener.addCertificates("WebCert", [webCert]);


        const StreamTaskDefinition = new ecs.FargateTaskDefinition(this, 'StreamingTask');

        const streaming = new ecs.ContainerDefinition(this, 'streaming', {
            taskDefinition: StreamTaskDefinition,
            image: image,
            environment: environment,
            secrets: secrets,
            command: ["yarn", "start"],
            logging: new ecs.AwsLogDriver({
                streamPrefix: 'streaming'
            })
        });

        streaming.addPortMappings({
            containerPort: 4000,
            protocol: ecs.Protocol.TCP,
        });

        const streamingService = new ecs.FargateService(this, 'StreamingService', {
            taskDefinition: StreamTaskDefinition,
            cluster: ecsCluster,
            assignPublicIp: true,
        });

        const streamingLoadBalancer = new elbv2.ApplicationLoadBalancer(this, 'StreamingLoadBalancer', {
            vpc: vpc,
            internetFacing: true
        });

        streamingLoadBalancer.addRedirect({
            sourceProtocol: ApplicationProtocol.HTTP,
            targetProtocol: ApplicationProtocol.HTTPS,
        });

        const streamingListener = streamingLoadBalancer.addListener('StreamingListener', {port: 443});
        streamingListener.addTargets('StreamingService', {
            port: 4000,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [streamingService]
        });

        const streamingCert = new certificateManager.DnsValidatedCertificate(this, 'StreamingCert', {
            hostedZone: zone,
            domainName: 'mastodon-stream.' + props.domain,
        });

        new route53.ARecord(this, 'StreamingRecord', {
            zone,
            recordName: "mastodon-stream",
            target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(streamingLoadBalancer)),
        });

        streamingListener.addCertificates('StreamingCert', [streamingCert]);

        const sideKickTaskDefinition = new ecs.FargateTaskDefinition(this, 'SidekickTask');

        new ecs.ContainerDefinition(this, 'SideKick', {
            taskDefinition: sideKickTaskDefinition,
            image: image,
            environment: environment,
            secrets: secrets,
            command: ["bundle", "exec", "sidekiq"],
            logging: new ecs.AwsLogDriver({
                streamPrefix: 'worker'
            })
        });

        const sideKickService = new ecs.FargateService(this, "SidekickService", {
            taskDefinition: sideKickTaskDefinition,
            cluster: ecsCluster,
            assignPublicIp: true,
        });

        [webService, streamingService, sideKickService].map(service => {
            service.connections.allowToDefaultPort(redisConnections);
            service.connections.allowToDefaultPort(esConnections);
            service.connections.allowToDefaultPort(rdsConnections);
            s3Bucket.grantReadWrite(service.taskDefinition.taskRole);
            s3Bucket.grantPutAcl(service.taskDefinition.taskRole);
        });

        const identity = new ses.EmailIdentity(this, 'SesIdentity', {
            identity: ses.Identity.publicHostedZone(zone),
        });
    }
}
