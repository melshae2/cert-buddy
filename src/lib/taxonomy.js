/**
 * Cert Buddy taxonomy: the topics you can tag a miss with, plus the
 * auto-detector that suggests topics from question text.
 *
 * Tuned for AWS SAP-C02. To retarget another cert, replace TOPICS — nothing
 * else in the extension hardcodes AWS.
 */
(function (root) {
  // category is only used for grouping in the dashboard.
  const TOPICS = [
    // --- Identity & governance ---
    ['iam', 'IAM', 'identity', ['iam', 'identity and access management', 'iam policy', 'iam role']],
    ['sts', 'STS / AssumeRole', 'identity', ['sts', 'assumerole', 'assume role', 'session token']],
    ['organizations', 'Organizations / SCP', 'identity', ['organizations', 'scp', 'service control polic', 'ou', 'organizational unit']],
    ['identity-center', 'IAM Identity Center', 'identity', ['identity center', 'aws sso', 'single sign-on']],
    ['cognito', 'Cognito', 'identity', ['cognito', 'user pool', 'identity pool']],
    ['ram', 'Resource Access Manager', 'identity', ['resource access manager', 'ram share', 'aws ram']],
    ['control-tower', 'Control Tower', 'identity', ['control tower', 'landing zone', 'guardrail']],

    // --- Networking ---
    ['vpc', 'VPC', 'networking', ['vpc', 'subnet', 'route table', 'cidr']],
    ['nat', 'NAT Gateway / Instance', 'networking', ['nat gateway', 'nat instance', 'natgw']],
    ['igw', 'Internet / Egress-only GW', 'networking', ['internet gateway', 'igw', 'egress-only']],
    ['vpc-endpoint', 'VPC Endpoints / PrivateLink', 'networking', ['vpc endpoint', 'privatelink', 'private link', 'interface endpoint', 'gateway endpoint']],
    ['tgw', 'Transit Gateway', 'networking', ['transit gateway', 'tgw']],
    ['peering', 'VPC Peering', 'networking', ['vpc peering', 'peering connection']],
    ['dx', 'Direct Connect', 'networking', ['direct connect', 'dx gateway', 'ddx']],
    ['vpn', 'Site-to-Site VPN', 'networking', ['site-to-site vpn', 'site to site vpn', 'vpn tunnel', 'customer gateway', 'virtual private gateway']],
    ['route53', 'Route 53', 'networking', ['route 53', 'route53', 'hosted zone', 'latency routing', 'failover routing', 'geolocation routing']],
    ['cloudfront', 'CloudFront', 'networking', ['cloudfront', 'edge location', 'oai', 'origin access']],
    ['global-accelerator', 'Global Accelerator', 'networking', ['global accelerator', 'anycast']],
    ['elb', 'ELB (ALB/NLB/GWLB)', 'networking', ['load balancer', 'alb', 'nlb', 'gwlb', 'elb', 'target group', 'listener rule']],
    ['sg-nacl', 'Security Groups / NACLs', 'networking', ['security group', 'network acl', 'nacl', 'ephemeral port']],

    // --- Compute ---
    ['ec2', 'EC2', 'compute', ['ec2', 'instance type', 'ami', 'placement group']],
    ['asg', 'Auto Scaling', 'compute', ['auto scaling', 'autoscaling', 'asg', 'launch template', 'warm pool']],
    ['pricing-models', 'Spot / RI / Savings Plans', 'compute', ['spot instance', 'spot fleet', 'reserved instance', 'savings plan']],
    ['lambda', 'Lambda', 'compute', ['lambda', 'cold start', 'provisioned concurrency', 'reserved concurrency']],
    ['ecs', 'ECS', 'containers', ['ecs', 'task definition', 'fargate task']],
    ['eks', 'EKS', 'containers', ['eks', 'kubernetes', 'irsa']],
    ['fargate', 'Fargate', 'containers', ['fargate']],
    ['ecr', 'ECR', 'containers', ['ecr', 'container registry']],
    ['batch', 'Batch', 'compute', ['aws batch']],
    ['outposts', 'Outposts / Local Zones', 'compute', ['outposts', 'local zone', 'wavelength']],
    ['beanstalk', 'Elastic Beanstalk', 'compute', ['beanstalk']],
    ['lightsail', 'Lightsail', 'compute', ['lightsail']],

    // --- Storage ---
    ['s3', 'S3', 'storage', ['s3', 'bucket policy', 'presigned url', 'multipart upload']],
    ['s3-classes', 'S3 Storage Classes / Lifecycle', 'storage', ['glacier', 'intelligent-tiering', 'intelligent tiering', 'lifecycle policy', 'storage class', 'deep archive']],
    ['s3-replication', 'S3 Replication', 'storage', ['crr', 'srr', 'cross-region replication', 'replication rule']],
    ['ebs', 'EBS', 'storage', ['ebs', 'gp3', 'gp2', 'io1', 'io2', 'snapshot']],
    ['efs', 'EFS', 'storage', ['efs', 'elastic file system']],
    ['fsx', 'FSx', 'storage', ['fsx', 'lustre', 'windows file server']],
    ['storage-gateway', 'Storage Gateway', 'storage', ['storage gateway', 'file gateway', 'volume gateway', 'tape gateway']],
    ['backup', 'AWS Backup', 'storage', ['aws backup', 'backup vault']],

    // --- Databases ---
    ['rds', 'RDS', 'database', ['rds', 'multi-az', 'read replica']],
    ['aurora', 'Aurora', 'database', ['aurora', 'global database', 'aurora serverless']],
    ['dynamodb', 'DynamoDB', 'database', ['dynamodb', 'gsi', 'lsi', 'dax', 'global table']],
    ['elasticache', 'ElastiCache', 'database', ['elasticache', 'redis', 'memcached']],
    ['redshift', 'Redshift', 'analytics', ['redshift', 'spectrum']],
    ['documentdb', 'DocumentDB / Neptune / Timestream', 'database', ['documentdb', 'neptune', 'timestream', 'keyspaces']],

    // --- App integration ---
    ['sqs', 'SQS', 'integration', ['sqs', 'dead-letter queue', 'dlq', 'fifo queue', 'visibility timeout']],
    ['sns', 'SNS', 'integration', ['sns', 'topic subscription', 'fan-out', 'fanout']],
    ['eventbridge', 'EventBridge', 'integration', ['eventbridge', 'event bus', 'cloudwatch events']],
    ['step-functions', 'Step Functions', 'integration', ['step functions', 'state machine']],
    ['api-gateway', 'API Gateway', 'integration', ['api gateway', 'usage plan', 'stage variable']],
    ['appsync', 'AppSync', 'integration', ['appsync', 'graphql']],
    ['mq', 'Amazon MQ / MSK', 'integration', ['amazon mq', 'rabbitmq', 'activemq', 'msk', 'kafka']],

    // --- Analytics ---
    ['kinesis', 'Kinesis', 'analytics', ['kinesis', 'data stream', 'firehose', 'shard']],
    ['athena', 'Athena / Glue', 'analytics', ['athena', 'aws glue', 'glue crawler', 'data catalog']],
    ['emr', 'EMR', 'analytics', ['emr', 'hadoop', 'spark cluster']],
    ['opensearch', 'OpenSearch', 'analytics', ['opensearch', 'elasticsearch']],
    ['quicksight', 'QuickSight / Lake Formation', 'analytics', ['quicksight', 'lake formation']],

    // --- Security ---
    ['kms', 'KMS', 'security', ['kms', 'cmk', 'customer managed key', 'key policy', 'envelope encryption']],
    ['secrets', 'Secrets Manager / SSM Params', 'security', ['secrets manager', 'parameter store', 'ssm parameter']],
    ['acm', 'ACM / Certificates', 'security', ['acm', 'certificate manager', 'tls certificate', 'ssl certificate']],
    ['waf-shield', 'WAF / Shield / Firewall', 'security', ['waf', 'shield advanced', 'network firewall', 'firewall manager']],
    ['guardduty', 'GuardDuty / Detective / Inspector', 'security', ['guardduty', 'detective', 'inspector', 'macie']],
    ['security-hub', 'Security Hub / Audit Manager', 'security', ['security hub', 'audit manager', 'artifact']],
    ['cloudhsm', 'CloudHSM', 'security', ['cloudhsm']],

    // --- Ops & observability ---
    ['cloudwatch', 'CloudWatch', 'observability', ['cloudwatch', 'metric filter', 'log group', 'composite alarm']],
    ['cloudtrail', 'CloudTrail', 'observability', ['cloudtrail', 'trail', 'data event']],
    ['config', 'AWS Config', 'observability', ['aws config', 'config rule', 'conformance pack']],
    ['xray', 'X-Ray', 'observability', ['x-ray', 'xray', 'trace segment']],
    ['systems-manager', 'Systems Manager', 'observability', ['systems manager', 'ssm', 'session manager', 'patch manager', 'run command']],

    // --- Deployment / IaC ---
    ['cloudformation', 'CloudFormation / CDK', 'iac', ['cloudformation', 'stackset', 'stack set', 'cdk', 'change set', 'custom resource']],
    ['codepipeline', 'CodePipeline / CodeBuild / CodeDeploy', 'iac', ['codepipeline', 'codebuild', 'codedeploy', 'codecommit', 'blue/green deploy']],
    ['proton-sc', 'Service Catalog / Proton', 'iac', ['service catalog', 'proton']],

    // --- Migration ---
    ['dms', 'DMS / SCT', 'migration', ['dms', 'database migration service', 'schema conversion']],
    ['mgn', 'Application Migration (MGN)', 'migration', ['application migration service', 'mgn', 'cloudendure', 'server migration']],
    ['datasync', 'DataSync / Transfer / Snow', 'migration', ['datasync', 'transfer family', 'snowball', 'snowmobile', 'snowcone']],
    ['migration-hub', 'Migration Hub / ADS', 'migration', ['migration hub', 'application discovery']],

    // --- Cross-cutting concepts ---
    ['cost', 'Cost optimization', 'concept', ['cost explorer', 'budgets', 'cost allocation tag', 'most cost-effective', 'least expensive', 'lowest cost']],
    ['dr', 'DR / RTO / RPO', 'concept', ['rto', 'rpo', 'pilot light', 'warm standby', 'disaster recovery', 'multi-region']],
    ['ha', 'High availability', 'concept', ['high availability', 'highly available', 'fault tolerant', 'availability zone']],
    ['hybrid', 'Hybrid architecture', 'concept', ['hybrid', 'on-premises', 'on premises', 'data center']],
    ['compliance', 'Compliance / data residency', 'concept', ['hipaa', 'pci dss', 'gdpr', 'data residency', 'fedramp']],
    ['perf', 'Performance / scaling', 'concept', ['latency', 'throughput', 'bottleneck', 'scale out', 'scale up']]
  ].map(([id, label, category, aliases]) => ({ id, label, category, aliases }));

  const CATEGORY_LABELS = {
    identity: 'Identity & Governance',
    networking: 'Networking',
    compute: 'Compute',
    containers: 'Containers',
    storage: 'Storage',
    database: 'Databases',
    integration: 'App Integration',
    analytics: 'Analytics',
    security: 'Security',
    observability: 'Ops & Observability',
    iac: 'Deployment & IaC',
    migration: 'Migration',
    concept: 'Concepts'
  };

  /**
   * Why you got it wrong. Collapsed from 7 buckets to 3 after reviewing real
   * capture data — the old 7-option select went unfilled on 28/30 captures.
   * Each of the 3 routes to a different remedy:
   *   never-learned -> study the material fresh (you never had it)
   *   no-recall     -> spaced review (you had it; memory didn't surface it in time)
   *   misread       -> exam-reading technique practice (knowledge was fine, execution wasn't)
   */
  const REASONS = [
    { id: 'never-learned', label: 'Never learned it' },
    { id: 'no-recall', label: "Knew it, couldn't recall" },
    { id: 'misread', label: 'Misread it' }
  ];

  /**
   * The stem discriminators exam questions turn on — the word or phrase that
   * tells you which of several plausible-looking answers is actually
   * correct ("least operational overhead" vs "most cost-effective" vs
   * "lowest latency" pick different services from the same scenario). This
   * is orthogonal to topic: two questions can both be about S3 and turn on
   * completely different discriminators.
   */
  const DISCRIMINATORS = [
    { id: 'cost', label: 'Cost', hint: 'Cheapest / most cost-effective option' },
    { id: 'ops', label: 'Operational overhead', hint: 'Least management, admin, or maintenance burden' },
    { id: 'rto-rpo', label: 'RTO / RPO', hint: 'Recovery time / recovery point objective' },
    { id: 'perf', label: 'Performance / latency', hint: 'Fastest, lowest latency, highest throughput' },
    { id: 'security', label: 'Security', hint: 'Most secure, least privilege, maximum security' },
    { id: 'migration', label: 'Migration / downtime', hint: 'Minimal downtime, disruption, or code change' }
  ];

  const byId = new Map(TOPICS.map((t) => [t.id, t]));
  const discById = new Map(DISCRIMINATORS.map((d) => [d.id, d]));

  function label(topicId) {
    return byId.get(topicId)?.label || topicId;
  }

  function reasonLabel(reasonId) {
    return REASONS.find((r) => r.id === reasonId)?.label || reasonId || '';
  }

  function discLabel(discId) {
    return discById.get(discId)?.label || discId || '';
  }

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Precompile one regex per topic: any alias, on word boundaries.
  const MATCHERS = TOPICS.map((t) => ({
    id: t.id,
    re: new RegExp('(^|[^a-z0-9])(' + t.aliases.map(escape).join('|') + ')([^a-z0-9]|$)', 'i')
  }));

  /** @returns {string[]} topic ids mentioned in the text, in taxonomy order. */
  function detect(text) {
    if (!text) return [];
    const hay = String(text).toLowerCase();
    return MATCHERS.filter((m) => m.re.test(hay)).map((m) => m.id);
  }

  /**
   * Score-ranked topic detection, split into what to auto-apply and what to
   * merely suggest. The correct answer is what actually happened, so a
   * mention there outweighs the question stem or your (wrong) answer:
   * correctAnswer = 2, question = 1, yourAnswer = 1 — a boolean hit per
   * field, summed. A score >= 2 auto-applies; a lone score of 1 is offered
   * as a suggestion instead of stamped automatically — a single generic
   * mention used to auto-apply and that's what over-tagged real capture
   * data (9 -> 16 topics on one session). 'concept' topics (cost, DR, HA…)
   * fire on generic exam language, so a score of 1 is dropped for them
   * entirely rather than suggested — they need score >= 2 to appear at all.
   * @returns {{apply: string[], suggest: string[]}} apply capped at 5,
   *   suggest capped at 4, both highest score first.
   */
  function detectWeighted({ question, yourAnswer, correctAnswer } = {}) {
    const fields = [
      [correctAnswer, 2],
      [question, 1],
      [yourAnswer, 1]
    ];
    const scores = new Map();
    for (const [text, points] of fields) {
      if (!text) continue;
      const hay = String(text).toLowerCase();
      for (const m of MATCHERS) {
        if (m.re.test(hay)) scores.set(m.id, (scores.get(m.id) || 0) + points);
      }
    }
    const apply = [];
    const suggest = [];
    for (const [id, score] of scores.entries()) {
      const isConcept = byId.get(id)?.category === 'concept';
      if (score >= 2) apply.push([id, score]);
      else if (!isConcept) suggest.push([id, score]); // concept + score 1 is dropped entirely
    }
    apply.sort((a, b) => b[1] - a[1]);
    suggest.sort((a, b) => b[1] - a[1]);
    return {
      apply: apply.slice(0, 5).map(([id]) => id),
      suggest: suggest.slice(0, 4).map(([id]) => id)
    };
  }

  /** Substring search over labels + aliases, for the tagger's topic picker. */
  function search(query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return TOPICS.slice(0, limit);
    return TOPICS.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        t.id.includes(q) ||
        t.aliases.some((a) => a.includes(q))
    ).slice(0, limit);
  }

  root.CertBuddyTaxonomy = {
    TOPICS,
    REASONS,
    DISCRIMINATORS,
    CATEGORY_LABELS,
    label,
    reasonLabel,
    discLabel,
    detect,
    detectWeighted,
    search,
    get: (id) => byId.get(id)
  };
})(globalThis);
