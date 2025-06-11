// Slack × Dify Bot - Streaming専用版

import fetch from 'node-fetch';
import { createParser } from 'eventsource-parser';
import { TextDecoder, TextEncoder } from 'util';
import { Blob } from 'buffer';
import { ReadableStream } from 'stream/web';
import DOMException from 'domexception';
import dotenv from 'dotenv';
import bolt from '@slack/bolt';
import { v5 as uuidv5 } from 'uuid';

dotenv.config();
const { App } = bolt;
const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const conversationMap = new Map();

if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.Blob === 'undefined') global.Blob = Blob;
if (typeof global.ReadableStream === 'undefined') global.ReadableStream = ReadableStream;
if (typeof global.DOMException === 'undefined') global.DOMException = DOMException;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  clientOptions: {
    headers: {
      'User-Agent': 'SlackBot/1.0'
    }
  }
});

// Streaming モード
async function queryDifyAgentStreaming(query, userId, conversationId = null, onDataChunk) {
  const payload = {
    inputs: {},
    query,
    response_mode: 'streaming',
    user: userId
  };
  if (conversationId) payload.conversation_id = conversationId;

  try {
    const response = await fetch('https://dify.app.uzabase.com/v1/chat-messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DIFY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to connect: ${response.status}`);
    }

    const decoder = new TextDecoder('utf-8');
    let latestConversationId = null;

    const parser = createParser({
      onEvent: (event) => {
        if (event.data === '[DONE]') return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.answer) {
            if (onDataChunk) onDataChunk(parsed.answer);
            if (parsed.conversation_id) latestConversationId = parsed.conversation_id;
          }
        } catch (err) {
          console.error('Parse error:', err);
        }
      }
    });

    for await (const chunk of response.body) {
      const str = decoder.decode(chunk, { stream: true });
      parser.feed(str);
    }

    return { conversation_id: latestConversationId };
  } catch (err) {
    console.error('Dify streaming fetch error:', err);
    return { conversation_id: null };
  }
}

function cleanQueryFromSlack(text) {
  return (text || '')
    .replace(/<@[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[\u0000-\u001F\u007F\uFFFD]/g, '')
    .trim();
}

function cleanForSlack(text) {
  try {
    if (typeof text !== 'string') return '';

    return text
      .normalize('NFC')
      .replace(/\u0000/g, '')  // NULL削除
      .replace(/\uFFFD/g, '') // Replacement character削除
      .replace(/[■◆◇◆]/g, '・') // Slack非対応記号を置換
      .replace(/^\s*[-*●•◉◦▪️]\s*/gm, '・') // 他の記号も置換
      .replace(/\n{3,}/g, '\n\n') // 改行を整理
      .replace(/^(■|◆|◇|●|・)/gm, '-')
      .replace(/\n\s*・/g, '\n  ・');
  } catch (e) {
    console.error('cleanForSlack error:', e);
    return '';
  }
}

app.event('app_mention', async ({ event, client }) => {
  const rawQuery = event.text;
  const cleanQuery = cleanQueryFromSlack(rawQuery);

  if (!cleanQuery || cleanQuery.length < 3) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `<@${event.user}> ごめんなさい、内容が読み取れませんでした。もう一度試してください。`
    });
    return;
  }

  const threadKey = event.thread_ts || event.ts;
  const userId = event.user;
  const previousConversationId = conversationMap.get(threadKey) || null;

  // Streaming モードのみ
  let messageBuffer = '';
  let slackInitialSent = false;
  let slackMessageTs = null;
  let lastUpdateTime = 0;
  let postMessagePromise = null;

  const { conversation_id } = await queryDifyAgentStreaming(
    cleanQuery,
    userId,
    previousConversationId,
    async (chunk) => {
      messageBuffer += chunk;

      if (!slackInitialSent && messageBuffer.length >= 30 && !postMessagePromise) {
        postMessagePromise = client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `<@${event.user}> ${cleanForSlack(messageBuffer)}`
        }).then(res => {
          slackMessageTs = res.ts;
          slackInitialSent = true;
          lastUpdateTime = Date.now();
        }).catch(console.error);
      }

      if (postMessagePromise && slackInitialSent) {
        const now = Date.now();
        if (now - lastUpdateTime >= 1000) {
          await postMessagePromise;
          await client.chat.update({
            channel: event.channel,
            ts: slackMessageTs,
            text: `<@${event.user}> ${cleanForSlack(messageBuffer)}`
          });
          lastUpdateTime = now;
        }
      }
    }
  );

  if (postMessagePromise) {
    await postMessagePromise;
    if (slackMessageTs) {
      await client.chat.update({
        channel: event.channel,
        ts: slackMessageTs,
        text: `<@${event.user}> ${cleanForSlack(messageBuffer)}`
      });
    }
  } else {
    const res = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `<@${event.user}> ${cleanForSlack(messageBuffer || '（応答がありませんでした）')}`
    });
    slackMessageTs = res.ts;
    slackInitialSent = true;
  }

  if (conversation_id && !conversationMap.has(threadKey)) {
    conversationMap.set(threadKey, conversation_id);
  }
});

(async () => {
  await app.start(); // ← ポート指定を削除
  console.log('⚡️ Bolt app is running in Socket Mode!');
})();
