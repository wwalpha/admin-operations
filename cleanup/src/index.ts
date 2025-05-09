import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  DeleteSecurityGroupCommand,
  DescribeSubnetsCommand,
  DeleteSubnetCommand,
  DescribeRouteTablesCommand,
  DeleteRouteTableCommand,
  DescribeImagesCommand,
  DeregisterImageCommand,
  DescribeSnapshotsCommand,
  DeleteSnapshotCommand,
} from '@aws-sdk/client-ec2';
import {
  DeleteLoginProfileCommand,
  DeleteUserCommand,
  DetachUserPolicyCommand,
  GenerateCredentialReportCommand,
  GetCredentialReportCommand,
  IAMClient,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  RemoveUserFromGroupCommand,
} from '@aws-sdk/client-iam';

const ec2Client = new EC2Client();
const iamClient = new IAMClient();

export const handler = async () => {
  await security_group();
  await subnet();
  await route_table();
  await ami();
  await snapshots();
  await iam_user();
};

const security_group = async () => {
  const response = await ec2Client.send(new DescribeSecurityGroupsCommand());

  if (!response || !response.SecurityGroups) {
    return;
  }

  const tasks = response.SecurityGroups.map(async (sg) => {
    try {
      // delete unused security groups
      await ec2Client.send(
        new DeleteSecurityGroupCommand({
          GroupId: sg.GroupId,
        })
      );
    } catch {}
  });

  await Promise.all(tasks);
};

const subnet = async () => {
  const response = await ec2Client.send(new DescribeSubnetsCommand());

  if (!response || !response.Subnets) {
    return;
  }

  const tasks = response.Subnets.map(async (sb) => {
    try {
      // delete unused subnets
      await ec2Client.send(
        new DeleteSubnetCommand({
          SubnetId: sb.SubnetId,
        })
      );
    } catch {}
  });

  await Promise.all(tasks);
};

const route_table = async () => {
  const response = await ec2Client.send(new DescribeRouteTablesCommand());

  if (!response || !response.RouteTables) {
    return;
  }

  const tasks = response.RouteTables.map(async (rt) => {
    try {
      // delete unused route tables
      await ec2Client.send(
        new DeleteRouteTableCommand({
          RouteTableId: rt.RouteTableId,
        })
      );
    } catch (err) {}
  });

  await Promise.all(tasks);
};

const ami = async () => {
  const response = await ec2Client.send(
    new DescribeImagesCommand({
      Owners: ['self'],
      Filters: [
        {
          Name: 'state',
          Values: ['available'],
        },
      ],
    })
  );

  if (!response || !response.Images) {
    return;
  }

  const tasks = response.Images.filter((ami) => {
    const creationDate = new Date(ami.CreationDate || '');
    const currentDate = new Date();
    const diffTime = Math.abs(currentDate.getTime() - creationDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays > 90;
  }).map(async (ami) => {
    try {
      // delete unused AMIs
      await ec2Client.send(
        new DeregisterImageCommand({
          ImageId: ami.ImageId,
        })
      );
    } catch (err) {}
  });

  await Promise.all(tasks);
};

const snapshots = async () => {
  const response = await ec2Client.send(
    new DescribeSnapshotsCommand({
      OwnerIds: ['self'],
    })
  );

  if (!response || !response.Snapshots) {
    return;
  }

  const tasks = response.Snapshots.filter((snapshot) => {
    const creationDate = new Date(snapshot.StartTime || '');
    const currentDate = new Date();
    const diffTime = Math.abs(currentDate.getTime() - creationDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays > 90;
  }).map(async (snapshot) => {
    try {
      // delete unused AMIs
      await ec2Client.send(
        new DeleteSnapshotCommand({
          SnapshotId: snapshot.SnapshotId,
        })
      );
    } catch (err) {}
  });

  await Promise.all(tasks);
};

const iam_user = async () => {
  const response = await iamClient.send(
    new GenerateCredentialReportCommand({
      ReportFormat: 'text',
    })
  );

  while (response.State !== 'COMPLETE') {
    console.log('Waiting for report generation...');
    await new Promise((res) => setTimeout(res, 3000));
  }

  const report = await iamClient.send(new GetCredentialReportCommand());
  const reportData = Buffer.from(report.Content as Uint8Array).toString('utf-8');

  const lines = reportData.split('\n');
  const headers = lines[0].split(',');

  const dataRows = lines.slice(1).filter((line) => {
    const values = line.split(',');
    const pswLastUsed = values[headers.indexOf('password_last_used')];
    const pswEnabled = values[headers.indexOf('password_enabled')];
    const arn = values[headers.indexOf('arn')];

    if (pswEnabled === 'false') {
      return false;
    }
    if (pswLastUsed === 'N/A' || pswLastUsed === 'no_information') {
      return false;
    }

    if (arn !== undefined && !arn.startsWith('arn:aws:iam::334678299258:user')) {
      return false;
    }

    const lastUsedDate = new Date(pswLastUsed);
    const currentDate = new Date();
    const diffTime = Math.abs(currentDate.getTime() - lastUsedDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 365) {
      return false;
    }

    return true;
  });

  const tasks = dataRows.map(async (row) => {
    const values = row.split(',');
    const userName = values[headers.indexOf('user')];

    console.log(`Deleting IAM user: ${userName}`);

    try {
      // delete login profile
      // This is needed to delete the user
      await iamClient.send(new DeleteLoginProfileCommand({ UserName: userName }));
    } catch (e) {}

    // ポリシーのデタッチ
    const policies = await iamClient.send(new ListAttachedUserPoliciesCommand({ UserName: userName }));
    for (const policy of policies.AttachedPolicies || []) {
      await iamClient.send(new DetachUserPolicyCommand({ UserName: userName, PolicyArn: policy.PolicyArn }));
    }

    const groups = await iamClient.send(new ListGroupsForUserCommand({ UserName: userName }));
    for (const group of groups.Groups || []) {
      await iamClient.send(new RemoveUserFromGroupCommand({ UserName: userName, GroupName: group.GroupName }));
    }

    await iamClient.send(new DeleteUserCommand({ UserName: userName }));
  });

  await Promise.all(tasks);
};

handler();
