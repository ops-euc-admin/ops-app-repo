const fetch = require('node-fetch');
const dotenv = require('dotenv');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');

dotenv.config();

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const INCLUDE_THREADS = process.env.INCLUDE_THREADS === 'true';

const headers = {
    Authorization: `Bearer ${SLACK_TOKEN}`,
    'Content-Type': 'application/json'
};

/**
 * Slack APIへのリクエストをレート制限を考慮して実行します。
 */
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

/**
 * 指定されたSlackチャンネル名を取得します。
 */
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

/**
 * 指定されたスレッドの返信メッセージを取得します。
 */
async function fetchThreadReplies(channelId, threadTs) {
    const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=200`;
    const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `replies:${channelId}`);
    const data = await res.json();
    if (!data.ok) {
        console.warn(`スレッドの返信取得に失敗しました (ts: ${threadTs}, channel: ${channelId}). Error: ${data.error}`);
        return [];
    }
    // スレッドの親メッセージを除外
    const replies = Array.isArray(data.messages) ? data.messages.slice(1) : [];
    return replies;
}

/**
 * 指定されたチャンネルからメッセージとスレッドの返信をすべて取得します。
 */
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
        
        if (Array.isArray(data.messages)) {
            for (const msg of data.messages) {
                // スレッドの親メッセージのみを対象とし、スレッド返信のメッセージは別途取得
                if (INCLUDE_THREADS && msg.thread_ts === msg.ts) {
                    const replies = await fetchThreadReplies(channelId, msg.thread_ts);
                    allMessages.push(msg);
                    allMessages.push(...replies);
                } else if (!msg.thread_ts) {
                    allMessages.push(msg);
                }
            }
        }

        hasMore = data.has_more;
        cursor = data.response_metadata?.next_cursor;
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    return allMessages;
}

/**
 * 指定されたSlackチャンネルから投稿を取得し、CSV形式の文字列を返します。
 */
async function getSlackPostsAndConvertToCsv(channelId, name) {
    if (!channelId) {
        throw new Error("チャンネルIDが指定されていません。");
    }

    try {
        const channelInfoRes = await fetchWithRateLimitRetry(
            `https://slack.com/api/conversations.info?channel=${channelId}`,
            { method: 'GET', headers },
            'channel info'
        );
        const channelInfoData = await channelInfoRes.json();
        if (!channelInfoData.ok) {
            throw new Error(`Slack API error (conversations.info): ${channelInfoData.error}`);
        }
        const teamId = channelInfoData.channel.team_id;
        const channelName = channelInfoData.channel.name;
        const safeName = (name || channelName).replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');
        const sourceLabel = `Slack #${channelName}`;

        const allMessages = await fetchMessagesWithThreads(channelId);

        const userMessages = allMessages
            .filter(msg => msg.text)
            .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

        const records = userMessages.map((msg) => {
            const cleanText = msg.text.replace(/\n/g, ' ').trim();
            
            const threadId = msg.thread_ts;
            const isReply = msg.thread_ts && msg.thread_ts !== msg.ts;
            
            // permalinkをボットトークンで生成
            const threadTsForPermalink = isReply ? msg.thread_ts : msg.ts;
            const threadUrl = `https://${teamId}.slack.com/archives/${channelId}/p${threadTsForPermalink.replace('.', '')}`;

            return {
                user: msg.user || '',
                text: cleanText,
                ts: msg.ts,
                thread_ts: isReply ? threadId : '', // スレッドの親メッセージには空欄
                thread_url: isReply ? threadUrl : '', // スレッド返信にのみURLを設定
                source: sourceLabel
            };
        });

        const csvString = stringify(records, {
            header: true,
            columns: ['user', 'text', 'ts', 'thread_ts', 'thread_url', 'source']
        });
        
        return { csvString, safeName };

    } catch (err) {
        console.error(`❌ 取得エラー (チャンネルID: ${channelId}):`, err.message);
        throw err;
    }
}

// --- コマンドラインからの独立実行用の部分 ---
if (require.main === module) {
    const channelId = process.argv[2];
    const name = process.argv[3];
    
    if (!channelId) {
        console.error("❌ チャンネルIDを引数で指定してください。例: node 1_slack-message-get.js C1234567890 \"general-channel\"");
        process.exit(1);
    }
    
    getSlackPostsAndConvertToCsv(channelId, name)
        .then(({ csvString, safeName }) => {
            const filePath = `slack_${safeName}.csv`;
            fs.writeFileSync(filePath, csvString);
            console.log(`✅ CSV出力完了: ${filePath}`);
        })
        .catch(err => {
            console.error(`❌ エラー (チャンネルID: ${channelId}): ${err.message}`);
            process.exit(1);
        });
}

module.exports = {
    getSlackPostsAndConvertToCsv
};