// ecr-to-ecs-deployer.js
const { ECSClient, UpdateServiceCommand, DescribeServicesCommand,
  DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand } = require('@aws-sdk/client-ecs');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const https = require('https');
const url = require('url');

// AWS リージョン
const region = process.env.AWS_REGION || 'ap-northeast-1';

// ECSクライアントの初期化
const ecsClient = new ECSClient({ region });
const ssmClient = new SSMClient({ region });

// 環境変数から設定を取得
const clusterName = process.env.ECS_CLUSTER;
const serviceName = process.env.ECS_SERVICE;
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
const updateTaskDefinition = (process.env.UPDATE_TASK_DEFINITION || 'true') === 'true';

/**
* ECRプッシュイベントをECSデプロイに変換するLambda関数
*/
exports.handler = async (event) => {
  console.log('受信したイベント:', JSON.stringify(event, null, 2));

  try {
    // ECRイベント情報を取得
    const repository = event.detail['repository-name'];
    const tag = event.detail['image-tag'];
    const accountId = event.account;
    const eventRegion = event.region;

    console.log(`ECRプッシュイベント検知: ${repository}:${tag}`);

    // latest以外のタグの場合はスキップするオプション
    const processOnlyLatest = (process.env.PROCESS_ONLY_LATEST || 'true') === 'true';
    if (processOnlyLatest && tag !== 'latest') {
      console.log(`タグ '${tag}' は 'latest' ではないためスキップします`);
      return {
        statusCode: 200,
        body: `Skipped deployment for non-latest tag: ${tag}`
      };
    }

    // 現在のサービス情報を取得
    const serviceResponse = await ecsClient.send(
      new DescribeServicesCommand({
        cluster: clusterName,
        services: [serviceName]
      })
    );

    if (!serviceResponse.services || serviceResponse.services.length === 0) {
      throw new Error(`Service ${serviceName} not found in cluster ${clusterName}`);
    }

    const service = serviceResponse.services[0];
    const currentTaskDefinitionArn = service.taskDefinition;
    console.log(`現在のタスク定義: ${currentTaskDefinitionArn}`);

    let newTaskDefinitionArn = currentTaskDefinitionArn;

    // タスク定義を更新する場合
    if (updateTaskDefinition) {
      // 現在のタスク定義の詳細を取得
      const taskDefResponse = await ecsClient.send(
        new DescribeTaskDefinitionCommand({
          taskDefinition: currentTaskDefinitionArn
        })
      );

      const taskDef = taskDefResponse.taskDefinition;

      // 新しいタスク定義を作成するために不要なフィールドを削除
      const newTaskDef = { ...taskDef };
      delete newTaskDef.taskDefinitionArn;
      delete newTaskDef.revision;
      delete newTaskDef.status;
      delete newTaskDef.requiresAttributes;
      delete newTaskDef.compatibilities;
      delete newTaskDef.registeredAt;
      delete newTaskDef.registeredBy;

      // イメージを更新
      let imageUpdated = false;

      if (newTaskDef.containerDefinitions && newTaskDef.containerDefinitions.length > 0) {
        for (const container of newTaskDef.containerDefinitions) {
          if (container.name === repository || (container.image && container.image.includes(repository))) {
            const newImage = `${accountId}.dkr.ecr.${eventRegion}.amazonaws.com/${repository}:${tag}`;
            const oldImage = container.image;
            container.image = newImage;
            imageUpdated = true;
            console.log(`コンテナイメージを更新します: ${oldImage} -> ${newImage}`);
          }
        }
      }

      if (!imageUpdated) {
        console.warn(`更新対象のコンテナが見つかりませんでした。リポジトリ名: ${repository}`);
        return {
          statusCode: 200,
          body: `No matching container found for ${repository}`
        };
      }

      // 新しいタスク定義を登録
      console.log('新しいタスク定義を登録します');
      const registerResponse = await ecsClient.send(
        new RegisterTaskDefinitionCommand(newTaskDef)
      );

      newTaskDefinitionArn = registerResponse.taskDefinition.taskDefinitionArn;
      console.log(`新しいタスク定義を登録しました: ${newTaskDefinitionArn}`);
    } else {
      console.log('タスク定義の更新をスキップします');
    }

    // サービスを更新
    console.log(`サービスを更新します: ${serviceName}`);
    const updateParams = {
      cluster: clusterName,
      service: serviceName,
      forceNewDeployment: true
    };

    // 新しいタスク定義で更新する場合
    if (updateTaskDefinition) {
      updateParams.taskDefinition = newTaskDefinitionArn;
    }

    const updateResponse = await ecsClient.send(
      new UpdateServiceCommand(updateParams)
    );

    console.log(`サービスを更新しました: ${serviceName}`);

    // Slack通知（設定されている場合）
    if (slackWebhookUrl) {
      await sendSlackNotification(
        slackWebhookUrl,
        repository,
        tag,
        clusterName,
        serviceName,
        newTaskDefinitionArn
      );
    }

    return {
      statusCode: 200,
      body: `Successfully updated ${serviceName} with ${repository}:${tag}`
    };

  } catch (error) {
    console.error('エラーが発生しました:', error);
    throw error;
  }
};

/**
* Slack通知を送信する
*/
async function sendSlackNotification(webhookUrl, repository, tag, cluster, service, taskDefinition) {
  try {
    const timestamp = new Date().toISOString();

    const message = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'ECSデプロイが完了しました 🚀'
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*リポジトリ:*\n${repository}`
            },
            {
              type: 'mrkdwn',
              text: `*タグ:*\n${tag}`
            }
          ]
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*クラスター:*\n${cluster}`
            },
            {
              type: 'mrkdwn',
              text: `*サービス:*\n${service}`
            }
          ]
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `デプロイ日時: ${timestamp}`
            }
          ]
        }
      ]
    };

    const params = url.parse(webhookUrl);
    const options = {
      hostname: params.hostname,
      path: params.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        console.log(`Slack通知ステータスコード: ${res.statusCode}`);
        res.on('data', (d) => {
          console.log(`Slack応答: ${d}`);
        });
        res.on('end', () => {
          resolve();
        });
      });

      req.on('error', (error) => {
        console.error('Slack通知エラー:', error);
        reject(error);
      });

      req.write(JSON.stringify(message));
      req.end();
    });
  } catch (error) {
    console.error('Slack通知の送信中にエラーが発生しました:', error);
    // メイン処理には影響させないため、例外は伝播させない
  }
}
