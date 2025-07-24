import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import fetch from 'node-fetch';

const app = new App({
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  token: process.env.SLACK_BOT_TOKEN
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
          const jsonData = JSON.parse(line.substring(6));
          if (jsonData.answer) { fullAnswer += jsonData.answer; }
          if (jsonData.conversation_id && !newConversationId) { newConversationId = jsonData.conversation_id; }
        } catch (e) { /* パースエラーは無視 */ }
      }
    }

    if (newConversationId) {
      conversationStore[conversationKey] = newConversationId;
      console.log(`[INFO] 新しい会話ID(${newConversationId})をキー(${conversationKey})で保存しました。`);
    }

    const answerText = fullAnswer.trim() || "（AIから有効な回答を得られませんでした）";

    await client.chat.postMessage({
      channel: event.channel,
      text: answerText,
      thread_ts: threadTs
    });
    console.log(`[INFO] Difyからの回答をスレッドに投稿しました。`);

  } catch (error) {
    console.error('[ERROR] Dify連携処理中にエラーが発生しました:', error);
    await client.chat.postMessage({
      channel: event.channel,
      text: "すみません、AIとの連携処理でエラーが発生しました！",
      thread_ts: threadTs
    });
  }
});

(async () => {
  await app.start();
  console.log('⚡️ 本番用Dify連携ボットが起動しました！！');
})();
