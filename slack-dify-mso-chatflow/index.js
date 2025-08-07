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

app.event('app_mention', async ({ event, say }) => {
  if (!botUserId) return;

  // Slackでの「スレッドID」を取得
  const thread_ts = event.thread_ts || event.ts;

  // そのスレッドに紐づくconversation_idを参照、なければ空
  let conversation_id = convMap[thread_ts] ?? "";

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

    // Difyから返却されるconversation_idでconvMapを更新
    if (response.data.conversation_id) {
      convMap[thread_ts] = response.data.conversation_id;
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
