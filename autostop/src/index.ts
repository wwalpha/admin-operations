import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { DescribeInstancesCommand, EC2Client, Instance, StopInstancesCommand } from '@aws-sdk/client-ec2';
import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
  StopTaskCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from '@aws-sdk/client-rds';

const ec2Client = new EC2Client();
const rdsClient = new RDSClient();
const ecsClient = new ECSClient();
const autoScalingClient = new AutoScalingClient({});

export const handler = async () => {
  await stopAutoScalingGroups();
  await stopInstance();
  await stopDBCluster();
  await stopDBInstances();
  await stopECSCluster();
};

const stopInstance = async () => {
  const results = await describeInstances();

  if (results.length === 0) return;

  await ec2Client.send(
    new StopInstancesCommand({
      InstanceIds: results.map((item) => item.InstanceId as string),
      Force: true,
    })
  );
};

const stopDBInstances = async () => {
  const results = await describeDBInstances();

  if (results.length === 0) return;

  // stop instances
  const tasks = results.map(async (item) => {
    try {
      await rdsClient.send(
        new StopDBInstanceCommand({
          DBInstanceIdentifier: item,
        })
      );
    } catch (e) {
      const err = e as any;

      if (err.Code === 'InvalidParameterCombination') {
        return;
      }

      throw e;
    }
  });

  await Promise.all(tasks);
};

const stopDBCluster = async () => {
  const results = await rdsClient.send(new DescribeDBClustersCommand({}));
  const dbClusters = results.DBClusters;

  if (!dbClusters) return;

  const tasks = dbClusters
    .filter((item) => item.Status === 'available')
    .map((item) =>
      rdsClient.send(
        new StopDBClusterCommand({
          DBClusterIdentifier: item.DBClusterIdentifier as string,
        })
      )
    );

  await Promise.all(tasks);
};

const stopECSCluster = async () => {
  const clusters = await listECSCluster();

  const tasks = clusters.map(async (cluster) => {
    const services = await listServices(cluster);

    await Promise.all(services.map((service) => stopServices(cluster, service)));
  });

  await Promise.all(tasks);
};

const stopServices = async (clusterArn: string, service: string) => {
  // update service
  await ecsClient.send(
    new UpdateServiceCommand({
      cluster: clusterArn,
      service: service,
      desiredCount: 0,
    })
  );

  // list tasks
  const tasks = await ecsClient.send(
    new ListTasksCommand({
      cluster: clusterArn,
    })
  );

  // stop tasks
  const allTask = tasks.taskArns?.map((item) =>
    ecsClient.send(
      new StopTaskCommand({
        cluster: clusterArn,
        task: item,
      })
    )
  );

  if (!allTask) return;

  await Promise.all(allTask);
};

const describeInstances = async (nextToken?: string): Promise<Instance[]> => {
  const results = await ec2Client.send(
    new DescribeInstancesCommand({
      NextToken: nextToken,
    })
  );

  let instances: Instance[] = [];

  results.Reservations?.forEach((item) => {
    instances = instances.concat([...(item.Instances ??= [])]);
  });

  // has next token
  if (results.NextToken) {
    const subInstances = await describeInstances(results.NextToken);

    return [...instances, ...subInstances];
  }

  return instances;
};

const describeDBInstances = async (nextToken?: string): Promise<string[]> => {
  let rets: string[] = [];

  const results = await rdsClient.send(
    new DescribeDBInstancesCommand({
      Marker: nextToken,
    })
  );

  const instances = results.DBInstances;

  if (!instances) return rets;

  // get instance list
  rets = instances
    .filter((item) => item.DBInstanceStatus === 'available')
    .map((item) => item.DBInstanceIdentifier as string);

  // has next token
  if (results.Marker) {
    const subInstances = await describeDBInstances(results.Marker);

    return [...rets, ...subInstances];
  }

  return rets;
};

const listECSCluster = async (nextToken?: string): Promise<string[]> => {
  const results = await ecsClient.send(
    new ListClustersCommand({
      nextToken: nextToken,
    })
  );

  let clusterArns: string[] = [];

  if (!results.clusterArns) return clusterArns;

  clusterArns = results.clusterArns;

  // has next token
  if (results.nextToken) {
    const subClusterArns = await listECSCluster(nextToken);

    return [...clusterArns, ...subClusterArns];
  }

  return clusterArns;
};

const listServices = async (cluster: string, nextToken?: string): Promise<string[]> => {
  let services: string[] = [];

  const results = await ecsClient.send(
    new ListServicesCommand({
      cluster: cluster,
      nextToken: nextToken,
    })
  );

  // validation
  if (!results.serviceArns) return services;

  services = results.serviceArns;

  // has next token
  if (results.nextToken) {
    const subServices = await listServices(cluster, nextToken);

    return [...services, ...subServices];
  }

  return services;
};

const stopAutoScalingGroups = async () => {
  // Get all Auto Scaling Groups
  const { AutoScalingGroups } = await autoScalingClient.send(new DescribeAutoScalingGroupsCommand({}));
  if (!AutoScalingGroups) return;

  // Set DesiredCapacity to 0 for each group
  const tasks = AutoScalingGroups.map((group) =>
    autoScalingClient.send(
      new UpdateAutoScalingGroupCommand({
        AutoScalingGroupName: group.AutoScalingGroupName,
        DesiredCapacity: 0,
      })
    )
  );

  await Promise.all(tasks);
};

// handler();
