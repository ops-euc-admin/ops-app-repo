require('dotenv').config();
const { App } = require('@slack/bolt');
const fetch = require('node-fetch');

const app = new App({
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  token: process.env.SLACK_BOT_TOKEN,
});

// 会話IDを一時的に保存するためのメモリ上のストア
const conversationStore = {};

// メンションされた時だけ反応する
app.event('app_mention', async ({ event, client }) => {
  // メッセージのテキストから、メンション部分を綺麗に取り除く
  const userText = event.text.replace(/<@U[0-9A-Z]+>\s*/, '').trim();

  // スレッドを特定するためのタイムスタンプを取得
  const threadTs = event.thread_ts || event.ts;
  const conversationKey = `${event.channel}-${threadTs}`;

  // メンションのみで質問がない場合は定型文を返す
  if (!userText) {
    await client.chat.postMessage({
      channel: event.channel,
      text: "はい、なんでしょうか？ :wave:",
      thread_ts: threadTs
    });
    return;
  }

  // 保存された会話IDを取得
  const conversationId = conversationStore[conversationKey] || "";
  console.log(`[INFO] Difyへの質問: "${userText}", 会話ID: ${conversationId || '（新規）'}`);

  try {
    const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DIFY_API_KEY}`},
      body: JSON.stringify({
        inputs: {},
        query: userText,
        response_mode: "streaming",
        conversation_id: conversationId,
        user: event.user
      })
    });

    if (!response.ok) { throw new Error(`Dify APIエラー: Status ${response.status}`); }

    let fullAnswer = "";
    let newConversationId = "";
    for await (const chunk of response.body) {
      const chunkStr = chunk.toString();
      const lines = chunkStr.split('\n').filter(line => line.startsWith('data: '));
      for (const line of lines) {
        try {

