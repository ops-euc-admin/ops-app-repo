const fetch = require('node-fetch');
const dotenv = require('dotenv');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');

dotenv.config();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
const INCLUDE_THREADS = process.env.INCLUDE_THREADS === 'true';

let headers;

/**
 * Slack APIへのリクエストをレート制限を考慮して実行します。
 */
async function fetchWithRateLimitRetry(url, options, label = '') {
    // ... (この関数は変更ありません)
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
 * 指定されたメッセージのパーマリンクを取得します。
 */
async function getPermalink(channelId, messageTs) {
    // ... (この関数は変更ありません)
    const params = new URLSearchParams({
        channel: channelId,
        message_ts: messageTs
    });
    const url = `https://slack.com/api/chat.getPermalink?${params.toString()}`;
    const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `permalink:${channelId}`);
    const data = await res.json();
    if (!data.ok) {
        console.warn(`パーマリンクの取得に失敗 (ts: ${messageTs}, channel: ${channelId}). Error: ${data.error}`);
        return '';
    }
    return data.permalink;
}


/**
 * 指定されたチャンネルのSlackチャンネル名を取得します。
 */
async function getChannelName(channelId) {
    // ... (この関数は変更ありません)
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
    // ... (この関数は変更ありません)
    const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=200`;
    const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `replies:${channelId}`);
    const data = await res.json();
    if (!data.ok) {
        console.warn(`スレッドの返信取得に失敗しました (ts: ${threadTs}, channel: ${channelId}). Error: ${data.error}`);
        return [];
    }
    return Array.isArray(data.messages) ? data.messages : [];
}

/**
 * 指定されたチャンネルからメッセージとスレッドの返信をすべて取得します。
 */
async function fetchMessagesWithThreads(channelId) {
    // ... (この関数は変更ありません)
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
// --- ★★★ ここからが修正されたロジックです ★★★ ---
async function getSlackPostsAndConvertToCsv(channelId, name) {
    if (!channelId) {
        throw new Error("チャンネルIDが指定されていません。");
    }

    if (!SLACK_BOT_TOKEN && !SLACK_USER_TOKEN) {
        throw new Error(".envファイルにSLACK_BOT_TOKENまたはSLACK_USER_TOKENを設定してください。");
    }

    let channelName;
    let isTokenSuccessful = false;

    // 1. まずボットトークンで試す
    if (SLACK_BOT_TOKEN) {
        console.log("🤖 ボットトークンでチャンネル履歴へのアクセスを試行します...");
        headers = { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' };
        try {
            // ★ 実際に履歴を取得するAPI(history)でアクセス可能か確認する
            const checkUrl = `https://slack.com/api/conversations.history?channel=${channelId}&limit=1`;
            const res = await fetchWithRateLimitRetry(checkUrl, { method: 'GET', headers }, 'history check');
            const data = await res.json();
            if (!data.ok) {
                throw new Error(data.error); // APIエラーの場合はエラーを発生させてcatchブロックへ
            }

            // history APIが成功したら、チャンネル名を取得してトークンを確定
            channelName = await getChannelName(channelId);
            isTokenSuccessful = true;
            console.log(`✅ ボットトークンでアクセス成功: #${channelName}`);

        } catch (error) {
            if (error.message && (error.message.includes('not_in_channel') || error.message.includes('channel_not_found'))) {
                // ボットが参加していない場合は警告を表示し、ユーザートークンでの再試行に進む
                console.warn("⚠️ ボットがチャンネルに参加していないため、ユーザートークンにフォールバックします。");
            } else {
                // その他の予期せぬエラーの場合は処理を中断
                console.error(`❌ ボットトークンでのアクセス中に予期せぬエラーが発生しました:`, error.message);
                throw error;
            }
        }
    }

    // 2. ボットトークンで失敗し、かつユーザートークンが設定されている場合、ユーザートークンで試す
    if (!isTokenSuccessful && SLACK_USER_TOKEN) {
        console.log("👤 ユーザートークンでチャンネル履歴へのアクセスを試行します...");
        headers = { Authorization: `Bearer ${SLACK_USER_TOKEN}`, 'Content-Type': 'application/json' };
        try {
            // ★ ユーザートークンでも同様にhistory APIでアクセス可能か確認
            const checkUrl = `https://slack.com/api/conversations.history?channel=${channelId}&limit=1`;
            const res = await fetchWithRateLimitRetry(checkUrl, { method: 'GET', headers }, 'history check');
            const data = await res.json();
            if (!data.ok) {
                throw new Error(data.error);
            }
            
            // 成功したらチャンネル名を取得してトークンを確定
            channelName = await getChannelName(channelId);
            isTokenSuccessful = true;
            console.log(`✅ ユーザートークンでアクセス成功: #${channelName}`);
        } catch (error) {
            // ユーザートークンでも失敗した場合は、エラーを投げて処理を終了
            console.error(`❌ ユーザートークンでもアクセスできませんでした:`, error.message);
            throw error;
        }
    }
    // --- ★★★ 修正ロジックはここまで ★★★ ---

    if (!isTokenSuccessful) {
        throw new Error(`利用可能なトークンではチャンネルID "${channelId}" にアクセスできませんでした。ボットの招待状況やトークンの権限を確認してください。`);
    }

    try {
        const safeName = (name || channelName).replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');
        const sourceLabel = `Slack #${channelName}`;

        const allMessages = await fetchMessagesWithThreads(channelId);

        const threadTss = [...new Set(allMessages.map(msg => msg.thread_ts).filter(Boolean))];
        const permalinkPromises = threadTss.map(ts => getPermalink(channelId, ts));
        const permalinks = await Promise.all(permalinkPromises);
        const threadUrlMap = new Map(threadTss.map((ts, i) => [ts, permalinks[i]]));


        const userMessages = allMessages
            .filter(msg => msg.text)
            .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

        const records = userMessages.map((msg) => {
            const cleanText = msg.text.replace(/\n/g, ' ').trim();
            const threadId = (msg.thread_ts && msg.thread_ts !== msg.ts) ? msg.thread_ts : '';
            const threadUrl = msg.thread_ts ? threadUrlMap.get(msg.thread_ts) || '' : '';

            return {
                user: msg.user || '',
                text: cleanText,
                ts: msg.ts,
                thread_ts: threadId,
                thread_url: threadUrl,
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

// --- コマンドラインからの独立実行用の部分 (変更なし) ---
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
            console.error(`❌ 最終エラー (チャンネルID: ${channelId}): ${err.message}`);
            process.exit(1);
        });
}

module.exports = {
    getSlackPostsAndConvertToCsv
};