import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createSourceOperationsHandler, type OperationsClient, type OperationsCommand } from './greenhouse-operations-api.js';
import { DynamoInternshipStore } from './store.js';

function adapter(clients: { sqs: SQSClient; cloudwatch: CloudWatchClient; ssm: SSMClient }): OperationsClient {
  const requiredString = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    async send<Output>(command: OperationsCommand<Output>): Promise<Output> {
      const input = command.input;
      if (command.operation === 'get-queue-attributes') return clients.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: requiredString(input.QueueUrl, 'QueueUrl'),
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      })) as Promise<Output>;
      if (command.operation === 'send-message') return clients.sqs.send(new SendMessageCommand({
        QueueUrl: requiredString(input.QueueUrl, 'QueueUrl'),
        MessageBody: requiredString(input.MessageBody, 'MessageBody'),
        MessageGroupId: requiredString(input.MessageGroupId, 'MessageGroupId'),
        MessageDeduplicationId: requiredString(input.MessageDeduplicationId, 'MessageDeduplicationId'),
      })) as Promise<Output>;
      if (command.operation === 'describe-alarms') return clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: requiredString(input.AlarmNamePrefix, 'AlarmNamePrefix') })) as Promise<Output>;
      return clients.ssm.send(new GetParametersByPathCommand({
        Path: requiredString(input.Path, 'Path'),
        Recursive: input.Recursive === true,
        WithDecryption: input.WithDecryption === true,
      })) as Promise<Output>;
    },
  };
}

const tableName = process.env.INTERNSHIPS_TABLE;
const queueUrl = process.env.GREENHOUSE_QUEUE_URL;
const deadLetterQueueUrl = process.env.GREENHOUSE_DEAD_LETTER_QUEUE_URL;
const sharedSecret = process.env.OPERATIONS_SHARED_SECRET;
const parameterPrefix = process.env.OPERATIONS_PROVIDER_PARAMETER_PREFIX;

export const handler = async (event: Parameters<ReturnType<typeof createSourceOperationsHandler>>[0]) => {
  if (!tableName || !sharedSecret || ((!queueUrl || !deadLetterQueueUrl) && !parameterPrefix)) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'OPERATIONS_NOT_CONFIGURED', message: 'Source operations data is not configured.' }) };
  }
  const client = adapter({ sqs: new SQSClient({}), cloudwatch: new CloudWatchClient({}), ssm: new SSMClient({}) });
  return createSourceOperationsHandler({
    store: new DynamoInternshipStore(tableName),
    queueUrl,
    deadLetterQueueUrl,
    parameterPrefix,
    sharedSecret,
    sqs: client,
    cloudwatch: client,
    ssm: client,
  })(event);
};
