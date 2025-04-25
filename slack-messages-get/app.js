const fetch = require('node-fetch');
const fs = require('fs');
const dotenv = require('dotenv');
const { createObjectCsvWriter } = require('csv-writer');

dotenv.config();

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TARGET_USER = process.env.TARGET_USER;
const INCLUDE_THREADS = process.env.INCLUDE_THREADS === 'true';
const THREAD_LIMIT_PER_CHANNEL = parseInt(process.env.THREAD_LIMIT_PER_CHANNEL || '10', 10);

const headers = {
  Authorization: `Bearer ${SLACK_TOKEN}`,
  'Content-Type': 'application/json'
};

// ✅ レート制限対応付き fetch
async function fetchWithRateLimitRetry(url, options, label = '') {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
      console.warn(`⏳ レート制限中 (${label})… ${retryAfter}秒待機`);
      await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
      attempt++;
      if (attempt >= 5) throw new Error(`レート制限が継続中です (${label})`);
      continue;
    }
    return res;
  }
}

// ✅ チャンネル名取得
async function getChannelName(channelId) {
  const res = await fetchWithRateLimitRetry(
    `https://slack.com/api/conversations.info?channel=${channelId}`,
    { method: 'GET', headers },
    'channel info'
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (channel info): ${data.error}`);
  return data.channel.name;
}

// ✅ スレッド返信取得
async function fetchThreadReplies(channelId, threadTs) {
  const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=20`;
  const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `replies:${channelId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (replies): ${data.error}`);
  return data.messages || [];
}

// ✅ メッセージ＋スレッド取得
async function fetchMessagesWithThreads(channelId) {
  let hasMore = true;
  let cursor = null;
  let allMessages = [];
  let threadFetchedCount = 0;

  while (hasMore) {
    const params = new URLSearchParams({ channel: channelId, limit: '200', oldest: '0' });
    if (cursor) params.append('cursor', cursor);

    const url = `https://slack.com/api/conversations.history?${params.toString()}`;
    const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `history:${channelId}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error (history): ${data.error}`);

    for (const msg of data.messages) {
      allMessages.push(msg);

      if (
        INCLUDE_THREADS &&
        msg.thread_ts &&
        msg.thread_ts === msg.ts &&
        threadFetchedCount < THREAD_LIMIT_PER_CHANNEL
      ) {
        const replies = await fetchThreadReplies(channelId, msg.thread_ts);
        allMessages.push(...replies.filter(r => r.ts !== msg.ts));
        threadFetchedCount++;
      }
    }

    hasMore = data.has_more;
    cursor = data.response_metadata?.next_cursor;
    await new Promise(resolve => setTimeout(resolve, 300)); // 軽く休憩
  }

  return allMessages;
}

// ✅ メイン処理
(async () => {
  try {
    const channelName = await getChannelName(CHANNEL_ID);
    const sourceLabel = `Slack #${channelName}`;

    const allMessages = await fetchMessagesWithThreads(CHANNEL_ID);

    const userMessages = allMessages
      .filter(msg => msg.user === TARGET_USER && msg.text)
      .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    const csvWriter = createObjectCsvWriter({
      path: 'dify_knowledge.csv',
      header: [
        { id: 'question', title: 'question' },
        { id: 'answer', title: 'answer' },
        { id: 'source', title: 'source' }
      ]
    });

    const records = userMessages.map((msg) => {
      const cleanText = msg.text.replace(/\n/g, ' ').trim();
      return {
        question: cleanText,
        answer: cleanText,
        source: sourceLabel
      };
    });

    await csvWriter.writeRecords(records);
    console.log(`✅ CSV出力完了: dify_knowledge.csv（${records.length}件）`);
  } catch (err) {
    console.error("❌ 取得エラー:", err.message);
  }
})();
