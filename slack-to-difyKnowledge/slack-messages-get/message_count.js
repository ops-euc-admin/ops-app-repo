const fetch = require('node-fetch');
const fs = require('fs');
const dotenv = require('dotenv');
const { createObjectCsvWriter } = require('csv-writer');

dotenv.config();

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const TARGET_USER = process.env.TARGET_USER;

const headers = {
  Authorization: `Bearer ${SLACK_TOKEN}`,
  'Content-Type': 'application/json'
};

// ✅ レート制限対応付き fetch ラッパー
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

// ✅ ユーザーが参加している全パブリックチャンネルを取得
async function fetchUserChannels(userId) {
  const url = `https://slack.com/api/users.conversations?user=${userId}&types=public_channel&limit=1000`;
  const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, 'users.conversations');
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (users.conversations): ${data.error}`);
  return data.channels.map(ch => ({ id: ch.id, name: ch.name }));
}

// ✅ スレッド内の返信取得
async function fetchThreadReplies(channelId, threadTs) {
  const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}`;
  const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `replies:${channelId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (replies): ${data.error}`);
  return data.messages || [];
}

// ✅ メッセージ + スレッド返信を含めて全取得
async function fetchMessagesWithThreads(channelId) {
  let hasMore = true;
  let cursor = null;
  let allMessages = [];

  while (hasMore) {
    const params = new URLSearchParams({ channel: channelId, limit: '200' });
    if (cursor) params.append('cursor', cursor);

    const url = `https://slack.com/api/conversations.history?${params.toString()}`;
    const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `history:${channelId}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error (history): ${data.error}`);

    for (const msg of data.messages) {
      allMessages.push(msg);
//      if (msg.thread_ts && msg.thread_ts === msg.ts) {
//        const replies = await fetchThreadReplies(channelId, msg.thread_ts);
//        allMessages.push(...replies.filter(r => r.ts !== msg.ts)); // 親メッセージ除く
//      }
    }

    hasMore = data.has_more;
    cursor = data.response_metadata?.next_cursor;
    await new Promise(resolve => setTimeout(resolve, 300)); // 軽い間引き
  }

  return allMessages;
}

// ✅ メイン処理
(async () => {
  try {
    const channels = await fetchUserChannels(TARGET_USER);
    const userMessageCounts = {};

    for (const { id: channelId, name: channelName } of channels) {
      console.log(`📥 チャンネル取得中: #${channelName}`);
      const messages = await fetchMessagesWithThreads(channelId);

      for (const msg of messages) {
        const user = msg.user;
        if (!user) continue;
        const key = `${channelName},${user}`;
        userMessageCounts[key] = (userMessageCounts[key] || 0) + 1;
      }

      await new Promise(resolve => setTimeout(resolve, 500)); // 各チャンネル間で休止
    }

    // ✅ CSV出力
    const records = Object.entries(userMessageCounts).map(([key, count]) => {
      const [channel, user] = key.split(',');
      return { channel, user, count };
    });

    const csvWriter = createObjectCsvWriter({
      path: 'slack_user_message_counts.csv',
      header: [
        { id: 'channel', title: 'channel' },
        { id: 'user', title: 'user' },
        { id: 'count', title: 'count' }
      ]
    });

    await csvWriter.writeRecords(records);
    console.log(`✅ 集計完了: slack_user_message_counts.csv（${records.length}件）`);
  } catch (err) {
    console.error("❌ エラー:", err.message);
  }
})();
