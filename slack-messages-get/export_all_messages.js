const fetch = require('node-fetch');
const fs = require('fs');
const dotenv = require('dotenv');
const { createObjectCsvWriter } = require('csv-writer');

dotenv.config();

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_IDS = process.env.CHANNEL_IDS ? process.env.CHANNEL_IDS.split(',') : [process.env.CHANNEL_ID];
const INCLUDE_THREADS = process.env.INCLUDE_THREADS === 'true';

const headers = {
  Authorization: `Bearer ${SLACK_TOKEN}`,
  'Content-Type': 'application/json'
};

// レート制限対応付き fetch
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

// チャンネル名取得
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

// スレッド返信取得
async function fetchThreadReplies(channelId, threadTs) {
  const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=20`;
  const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `replies:${channelId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error (replies): ${data.error}`);
  return data.messages || [];
}

// メッセージ＋スレッド取得
async function fetchMessagesWithThreads(channelId) {
  let hasMore = true;
  let cursor = null;
  const allMessages = [];

  while (hasMore) {
    const params = new URLSearchParams({ channel: channelId, limit: '200' });
    if (cursor) params.append('cursor', cursor);

    const url = `https://slack.com/api/conversations.history?${params.toString()}`;
    const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `history:${channelId}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error (history): ${data.error}`);

    for (const msg of data.messages) {
      // スレッド親メッセージならrepliesもすべて取得
      if (
        INCLUDE_THREADS &&
        msg.thread_ts &&
        msg.thread_ts === msg.ts
      ) {
        const replies = await fetchThreadReplies(channelId, msg.thread_ts);
        allMessages.push(msg);
        allMessages.push(...replies.filter(r => r.ts !== msg.ts));
      }
      // 通常メッセージ
      else if (!msg.thread_ts) {
        allMessages.push(msg);
      }
    }

    hasMore = data.has_more;
    cursor = data.response_metadata?.next_cursor;
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  return allMessages;
}

// メイン処理
(async () => {
  try {
    for (const channelIdRaw of CHANNEL_IDS) {
      const channelId = channelIdRaw.trim();
      if (!channelId) continue;
      const channelName = await getChannelName(channelId);
      // ファイル名に使えない文字を除去
      const safeChannelName = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const sourceLabel = `Slack #${channelName}`;

      const allMessages = await fetchMessagesWithThreads(channelId);

      // 投稿者でフィルタしない
      const userMessages = allMessages
        .filter(msg => msg.text)
        .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

      const csvWriter = createObjectCsvWriter({
        path: `all_slack_messages_${safeChannelName}.csv`,
        header: [
          { id: 'user', title: 'user' },
          { id: 'text', title: 'text' },
          { id: 'ts', title: 'timestamp' },
          { id: 'thread_ts', title: 'thread_ts' },
          { id: 'source', title: 'source' }
        ]
      });

      const records = userMessages.map((msg) => {
        const cleanText = msg.text.replace(/\n/g, ' ').trim();
        const threadId = (msg.thread_ts && msg.thread_ts !== msg.ts) ? msg.thread_ts : '';
        return {
          user: msg.user || '',
          text: cleanText,
          ts: msg.ts,
          thread_ts: threadId,
          source: sourceLabel
        };
      });

      await csvWriter.writeRecords(records);
      console.log(`✅ CSV出力完了: all_slack_messages_${safeChannelName}.csv（${records.length}件）`);
    }
  } catch (err) {
    console.error("❌ 取得エラー:", err.message);
  }
})();
