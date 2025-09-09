const { App } = require('@slack/bolt');
const axios = require('axios');
require('dotenv').config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// botユーザーIDの取得（メンション除去用）
let botUserId;
(async () => {
  const authRes = await app.client.auth.test({ token: process.env.SLACK_BOT_TOKEN });
  botUserId = authRes.user_id;
  await app.start();
  console.log('⚡️ Bolt app is running!');
})();

function removeBotMention(text, botUserId) {
  const reg = new RegExp(`^<@${botUserId}>[\\s\\u3000]*`);
  return text.replace(reg, '').trim();
}

// スレッドID(thread_ts) <-> Dify conversation_id のマッピング（インメモリ例）
const convMap = {};

// 🔄 1時間ごとに古い会話データを削除
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  for (const ts in convMap) {
    if (now - convMap[ts].updatedAt > oneHour) {
      delete convMap[ts];
      console.log(`🗑 conversation expired and deleted (thread_ts=${ts})`);
    }
  }
}, 60 * 60 * 1000); // 1時間ごとにクリーンアップ処理

app.event('app_mention', async ({ event, say }) => {
  if (!botUserId) return;

  // Slackでの「スレッドID」を取得
  const thread_ts = event.thread_ts || event.ts;

  // そのスレッドに紐づくconversation_idを参照、なければ空
  // ?.はconvMap[thread_ts]がnullもしくはundefinedなのかを確認している。
  // nullでもundefinedでもなければconversation_idプロパティが呼び出される。
  let conversation_id = convMap[thread_ts]?.conversation_id ?? "";
  
  
  // メンション除去
  const cleanText = removeBotMention(event.text, botUserId);

  // Difyリクエスト
  const data = {
    inputs: {},
    query: cleanText,
    response_mode: "blocking",
    conversation_id: conversation_id,
    user: event.user,
    files: []
  };

  try {
    const response = await axios.post(
      process.env.DIFY_API_ENDPOINT,
      data,
      {
        headers: {
          'Authorization': `Bearer ${process.env.DIFY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // convMap更新（最後に使った時刻を保存）
    if (response.data.conversation_id) {
      convMap[thread_ts] = {
        conversation_id: response.data.conversation_id,
        updatedAt: Date.now()
      };
    }


    await say({
      text: response.data.answer || "Difyから応答がありませんでした。",
      thread_ts: thread_ts
    });

  } catch (err) {
    await say({
      text: "Dify API連携エラー: " + err.message,
      thread_ts: thread_ts
    });
  }
});
