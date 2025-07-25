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

// 共通の処理本体
async function handleUserMessage({ event, client }) {
  // メッセージのテキストから、メンション部分を綺麗に取り除く（DMでは不要だが共通化）
  const userText = (event.text || '').replace(/<@U[0-9A-Z]+>\s*/, '').trim();

  // スレッドの親メッセージのtsを常に使う
  const threadTs = event.thread_ts || event.ts;
  const conversationKey = `${event.channel}-${event.thread_ts || event.ts}`;

  if (!userText) {
    return;
  }

  const conversationId = conversationStore[conversationKey] || "";
  console.log(`[INFO] Difyへの質問: "${userText}", 会話ID: ${conversationId || '（新規）'}`);

  // 仮メッセージ
  const pending = await client.chat.postMessage({
    channel: event.channel,
    text: "回答準備中です。少々お待ちください。",
    thread_ts: threadTs
  });

  let parentDeleted = false;
  let parentCheckInterval = null;
  // 親スレッドの削除チェック関数
  async function checkParentDeleted() {
    try {
      const replies = await client.conversations.replies({
        channel: event.channel,
        ts: threadTs,
        limit: 1
      });
      if (!replies.messages || replies.messages.length === 0) {
        parentDeleted = true;
        console.log(`[INFO] 親スレッド(${threadTs})が削除されたため投稿を停止します。`);
      }
    } catch (e) {
      // APIエラー時は停止しない
      console.warn('[WARN] 親スレッド削除チェックでエラー:', e);
    }
  }

  try {
    // 30秒ごとに親スレッドの削除をチェック
    parentCheckInterval = setInterval(checkParentDeleted, 30000);

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
    let lastUpdateText = "";
    let lastUpdateTime = Date.now();
    const updateInterval = 2000; // 2秒ごとにSlackを更新

    for await (const chunk of response.body) {
      if (parentDeleted) {
        throw new Error('親スレッドが削除されたため投稿を中断します');
      }
      const chunkStr = chunk.toString();
      const lines = chunkStr.split('\n').filter(line => line.startsWith('data: '));
      for (const line of lines) {
        try {
          const jsonData = JSON.parse(line.substring(6));
          if (jsonData.answer) { fullAnswer += jsonData.answer; }
          if (jsonData.conversation_id && !newConversationId) { newConversationId = jsonData.conversation_id; }
        } catch (e) { /* パースエラーは無視 */ }
      }
      // 2秒ごとにSlackメッセージを更新（fullAnswerが空の間は更新しない）
      if (Date.now() - lastUpdateTime > updateInterval && !parentDeleted) {
        if (fullAnswer.trim().length > 0) {
          const answerText = formatForSlack(fullAnswer.trim());
          const messages = splitMessage(answerText);
          if (messages[0] !== lastUpdateText) {
            await client.chat.update({
              channel: event.channel,
              ts: pending.ts,
              text: messages[0],
              thread_ts: threadTs
            });
            lastUpdateText = messages[0];
          }
          lastUpdateTime = Date.now();
        }
      }
    }

    if (newConversationId) {
      conversationStore[conversationKey] = newConversationId;
      console.log(`[INFO] 新しい会話ID(${newConversationId})をキー(${conversationKey})で保存しました。`);
    }

    // DifyのMarkdownをSlack向けに整形
    function formatForSlack(text) {
      return text
        // 箇条書きの「* 」または「- 」をSlackの「- 」に変換
        .replace(/^[*-] (.*)$/gm, '- $1')
        // Markdown太字「**text**」をSlack太字「*text*」に変換（複数行・複数箇所対応）
        .replace(/\*\*([^\*]+?)\*\*/g, '*$1*')
        // 6～1個の#で始まる行をすべて太字に
        .replace(/^###### (.*)$/gm, '*$1*')
        .replace(/^##### (.*)$/gm, '*$1*')
        .replace(/^#### (.*)$/gm, '*$1*')
        .replace(/^### (.*)$/gm, '*$1*')
        .replace(/^## (.*)$/gm, '*$1*')
        .replace(/^# (.*)$/gm, '*$1*')
        // 区切り線「***」を削除
        .replace(/^[*]{3,}$/gm, '');
    }

    // 最終的な回答を分割して投稿
    const answerText = formatForSlack(fullAnswer.trim() || "（AIから有効な回答を得られませんでした）");
    const messages = splitMessage(answerText);

    // 1つ目は仮メッセージを上書き
    if (!parentDeleted) {
      await client.chat.update({
        channel: event.channel,
        ts: pending.ts,
        text: messages[0],
        thread_ts: threadTs
      });
    }

    // 2つ目以降も必ず3900文字以内で投稿
    for (let i = 1; i < messages.length; i++) {
      if (parentDeleted) break;
      await client.chat.postMessage({
        channel: event.channel,
        text: messages[i],
        thread_ts: threadTs
      });
    }

    if (!parentDeleted) {
      console.log(`[INFO] Difyからの回答をスレッド(${threadTs})に投稿しました。`);
    }

  } catch (error) {
    console.error('[ERROR] Dify連携処理中にエラーが発生しました:', error);
    await client.chat.postMessage({
      channel: event.channel,
      text: "すみません、AIとの連携処理でエラーが発生しました！",
      thread_ts: threadTs
    });
  } finally {
    if (parentCheckInterval) clearInterval(parentCheckInterval);
  }
}

// Slackの投稿上限でメッセージを分割する関数
function splitMessage(text, maxBytes = 3900) {
  const result = [];
  let buffer = '';
  let bufferBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bufferBytes + charBytes > maxBytes) {
      result.push(buffer);
      buffer = '';
      bufferBytes = 0;
    }
    buffer += char;
    bufferBytes += charBytes;
  }
  if (buffer) {
    result.push(buffer);
  }
  return result;
}

// メンションイベント
app.event('app_mention', async ({ event, client }) => {
  await handleUserMessage({ event, client });
});

// DMイベント
app.event('message', async ({ event, client }) => {
  if (event.channel_type === 'im' && !event.bot_id) {
    await handleUserMessage({ event, client });
  }
});

(async () => {
  await app.start();
  console.log('⚡️ 本番用Dify連携ボットが起動しました！！');
})();
