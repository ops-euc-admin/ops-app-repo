const fetch = require('node-fetch');
const dotenv = require('dotenv');
const fs = require('fs'); // ファイルI/Oのために追加

dotenv.config();

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const INCLUDE_THREADS = process.env.INCLUDE_THREADS === 'true';

const headers = {
    Authorization: `Bearer ${SLACK_TOKEN}`,
    'Content-Type': 'application/json'
};

/**
 * Slack APIへのリクエストをレート制限を考慮して実行します。
 * @param {string} url - リクエストURL
 * @param {Object} options - fetchオプション
 * @param {string} label - ログ出力用のラベル
 * @returns {Promise<Response>} fetchのレスポンス
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
 * 指定されたチャンネルのSlackチャンネル名を取得します。
 * @param {string} channelId - SlackチャンネルID
 * @returns {Promise<string>} チャンネル名
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
 * @param {string} channelId - SlackチャンネルID
 * @param {string} threadTs - スレッドのタイムスタンプ
 * @returns {Promise<Array<Object>>} スレッド返信メッセージの配列
 */
async function fetchThreadReplies(channelId, threadTs) {
    const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=20`;
    const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `replies:${channelId}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error (replies): ${data.error}`);
    return data.messages || [];
}

/**
 * 指定されたチャンネルからメッセージとスレッドの返信をすべて取得します。
 * @param {string} channelId - SlackチャンネルID
 * @returns {Promise<Array<Object>>} 取得したすべてのメッセージの配列
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

        for (const msg of data.messages) {
            if (
                INCLUDE_THREADS &&
                msg.thread_ts &&
                msg.thread_ts === msg.ts
            ) {
                const replies = await fetchThreadReplies(channelId, msg.thread_ts);
                allMessages.push(msg);
                allMessages.push(...replies.filter(r => r.ts !== msg.ts));
            }
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

/**
 * 指定されたSlackチャンネルから投稿を取得し、CSV形式の文字列を返します。
 * この関数は他のモジュールから呼び出されることを想定しています。
 * @param {string} channelId - SlackチャンネルID
 * @param {string} [name] - 保存名（省略可能）。ファイル名の一部として使用される。
 * @returns {Promise<{csvString: string, safeName: string}>} 生成されたCSV文字列と安全なファイル名
 */
async function getSlackPostsAndConvertToCsv(channelId, name) {
    if (!channelId) {
        throw new Error("チャンネルIDが指定されていません。");
    }

    try {
        // nameが指定されていない場合、Slack APIからチャンネル名を取得して代替
        const channelName = await getChannelName(channelId);
        const safeName = (name || channelName).replace(/[^a-zA-Z0-9_-]/g, '_');
        const sourceLabel = `Slack #${channelName}`;

        const allMessages = await fetchMessagesWithThreads(channelId);
        const userMessages = allMessages
            .filter(msg => msg.text)
            .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

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

        const csvHeader = 'user,text,timestamp,thread_ts,source';
        const csvRecords = records.map(record => `${record.user},"${record.text}",${record.ts},${record.thread_ts},"${record.source}"`);
        const csvString = [csvHeader, ...csvRecords].join('\n');
        
        return { csvString, safeName };

    } catch (err) {
        console.error("❌ 取得エラー:", err.message);
        throw err;
    }
}

// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node slack-app.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    const channelId = process.argv[2];
    const name = process.argv[3]; // オプションの保存名
    
    if (!channelId) {
        console.error("❌ チャンネルIDを引数で指定してください。例: node slack-app.js C1234567890 \"general-channel\"");
        process.exit(1);
    }
    
    // getSlackPostsAndConvertToCsv 関数を呼び出し
    getSlackPostsAndConvertToCsv(channelId, name)
        .then(({ csvString, safeName }) => {
            // CSV文字列をファイルに書き出す
            const filePath = `slack_${safeName}.csv`;
            fs.writeFileSync(filePath, csvString);
            console.log(`✅ CSV出力完了: ${filePath}`);
        })
        .catch(err => {
            console.error(`❌ エラー: ${err.message}`);
            process.exit(1);
        });
}

// 他のファイルから require で呼び出せるように関数を公開
module.exports = {
    getSlackPostsAndConvertToCsv
};
