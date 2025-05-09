"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_ec2_1 = require("@aws-sdk/client-ec2");
const client_ecs_1 = require("@aws-sdk/client-ecs");
const client_rds_1 = require("@aws-sdk/client-rds");
const ec2Client = new client_ec2_1.EC2Client();
const rdsClient = new client_rds_1.RDSClient();
const ecsClient = new client_ecs_1.ECSClient();
const handler = async () => {
    await stopInstance();
    await stopDBInstances();
    await stopECSCluster();
    await stopDBCluster();
};
exports.handler = handler;
const stopInstance = async () => {
    const results = await describeInstances();
    if (results.length === 0)
        return;
    await ec2Client.send(new client_ec2_1.StopInstancesCommand({
        InstanceIds: results.map((item) => item.InstanceId),
        Force: true,
    }));
};
const stopDBInstances = async () => {
    const results = await describeDBInstances();
    if (results.length === 0)
        return;
    // stop instances
    const tasks = results.map((item) => rdsClient.send(new client_rds_1.StopDBInstanceCommand({
        DBInstanceIdentifier: item,
    })));
    await Promise.all(tasks);
};
const stopDBCluster = async () => {
    const results = await rdsClient.send(new client_rds_1.DescribeDBClustersCommand({}));
    const dbClusters = results.DBClusters;
    if (!dbClusters)
        return;
    const tasks = dbClusters
        .filter((item) => item.Status === 'available')
        .map((item) => rdsClient.send(new client_rds_1.StopDBClusterCommand({
        DBClusterIdentifier: item.DBClusterIdentifier,
    })));
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
const stopServices = async (clusterArn, service) => {
    // update service
    await ecsClient.send(new client_ecs_1.UpdateServiceCommand({
        cluster: clusterArn,
        service: service,
        desiredCount: 0,
    }));
    // list tasks
    const tasks = await ecsClient.send(new client_ecs_1.ListTasksCommand({
        cluster: clusterArn,
    }));
    // stop tasks
    const allTask = tasks.taskArns?.map((item) => ecsClient.send(new client_ecs_1.StopTaskCommand({
        cluster: clusterArn,
        task: item,
    })));
    if (!allTask)
        return;
    await Promise.all(allTask);
};
const describeInstances = async (nextToken) => {
    const results = await ec2Client.send(new client_ec2_1.DescribeInstancesCommand({
        NextToken: nextToken,
    }));
    let instances = [];
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
const describeDBInstances = async (nextToken) => {
    let rets = [];
    const results = await rdsClient.send(new client_rds_1.DescribeDBInstancesCommand({
        Marker: nextToken,
    }));
    const instances = results.DBInstances;
    if (!instances)
        return rets;
    // get instance list
    rets = instances.map((item) => item.DBInstanceIdentifier);
    // has next token
    if (results.Marker) {
        const subInstances = await describeDBInstances(results.Marker);
        return [...rets, ...subInstances];
    }
    return rets;
};
const listECSCluster = async (nextToken) => {
    const results = await ecsClient.send(new client_ecs_1.ListClustersCommand({
        nextToken: nextToken,
    }));
    let clusterArns = [];
    if (!results.clusterArns)
        return clusterArns;
    clusterArns = results.clusterArns;
    // has next token
    if (results.nextToken) {
        const subClusterArns = await listECSCluster(nextToken);
        return [...clusterArns, ...subClusterArns];
    }
    return clusterArns;
};
const listServices = async (cluster, nextToken) => {
    let services = [];
    const results = await ecsClient.send(new client_ecs_1.ListServicesCommand({
        cluster: cluster,
        nextToken: nextToken,
    }));
    // validation
    if (!results.serviceArns)
        return services;
    services = results.serviceArns;
    // has next token
    if (results.nextToken) {
        const subServices = await listServices(cluster, nextToken);
        return [...services, ...subServices];
    }
    return services;
};
// handler();
