const fetch = require('node-fetch');
const dotenv = require('dotenv');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');
const pLimit = require('p-limit').default;

dotenv.config();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
const INCLUDE_THREADS = process.env.INCLUDE_THREADS === 'true';
const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL;

let headers;

// (getChannelName, fetchThreadReplies, fetchWithRateLimitRetry の各関数は変更ありません)
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

async function getChannelName(channelId) {
    const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.info?channel=${channelId}`, { method: 'GET', headers }, 'channel info');
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error (channel info): ${data.error}`);
    return data.channel.name;
}
async function fetchThreadReplies(channelId, threadTs) {
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
    console.log(`[1/2] チャンネル履歴の取得を開始します (チャンネルID: ${channelId})`);
    let hasMore = true;
    let cursor = null;
    const messagesFromHistory = [];
    while (hasMore) {
        const params = new URLSearchParams({ channel: channelId, limit: '200' });
        if (cursor) params.append('cursor', cursor);
        const url = `https://slack.com/api/conversations.history?${params.toString()}`;
        const res = await fetchWithRateLimitRetry(url, { method: 'GET', headers }, `history:${channelId}`);
        const data = await res.json();
        if (!data.ok) throw new Error(`Slack API error (history): ${data.error}`);
        if (Array.isArray(data.messages)) {
            messagesFromHistory.push(...data.messages);
        }
        hasMore = data.has_more;
        cursor = data.response_metadata?.next_cursor;
        if (hasMore) {
            await new Promise(resolve => setTimeout(resolve, 1500)); 
        }
    }
    console.log(`✅ チャンネル履歴の取得完了。`);
    
    const allMessages = [];
    const threadTsToFetch = new Set(); 
    for (const msg of messagesFromHistory) {
        if (!msg.thread_ts || msg.ts === msg.thread_ts) {
            allMessages.push(msg);
        }
        if (INCLUDE_THREADS && msg.thread_ts && msg.ts === msg.thread_ts) {
            threadTsToFetch.add(msg.thread_ts);
        }
    }

    if (INCLUDE_THREADS && threadTsToFetch.size > 0) {
        const limit = pLimit(3); 
        const MIN_INTERVAL = 3000;

        const threadTsArray = Array.from(threadTsToFetch);
        console.log(`[2/2] ${threadTsToFetch.size}件のスレッドを取得します...`);
        
        let processedCount = 0;
        const totalCount = threadTsArray.length;

        const promises = threadTsArray.map(ts => {
            return limit(async () => {
                const startTime = Date.now();
                const result = await fetchThreadReplies(channelId, ts);
                
                const elapsedTime = Date.now() - startTime;
                const delayNeeded = MIN_INTERVAL - elapsedTime;

                if (delayNeeded > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayNeeded));
                }
                
                processedCount++;
                process.stdout.write(`  - スレッド取得中: ${processedCount} / ${totalCount} (${Math.round((processedCount / totalCount) * 100)}%)\r`);
                return result;
            });
        });

        const allRepliesNested = await Promise.all(promises);
        process.stdout.write('\n');
        
        const allReplies = allRepliesNested.flat();
        const parentTsSet = new Set(allMessages.map(m => m.ts));
        const uniqueReplies = allReplies.filter(reply => !parentTsSet.has(reply.ts));
        allMessages.push(...uniqueReplies);
        
        console.log(`✅ スレッドの取得完了。`);
    }

    return allMessages;
}

/**
 * 指定されたSlackチャンネルから投稿を取得し、CSVファイルとして保存します。
 * @param {string} channelId チャンネルID
 * @param {string} [name] ファイル名に使用する名前（オプション）
 * @returns {Promise<string>} 保存されたCSVファイルのパス
 */
async function getSlackPostsAndConvertToCsv(channelId, name) {
    let csvString = '';
    // エラー時に備えて、ファイル名を事前に安全な形式で定義
    let safeName = (name || channelId).replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');
    let filePath = `slack_${safeName}.csv`;

    try {
        if (!channelId) { throw new Error("チャンネルIDが指定されていません。"); }
        if (!SLACK_WORKSPACE_URL) { throw new Error(".envファイルにSLACK_WORKSPACE_URL（例: https://your-workspace.slack.com）を設定してください。"); }
        if (!SLACK_BOT_TOKEN && !SLACK_USER_TOKEN) { throw new Error(".envファイルにSLACK_BOT_TOKENまたはSLACK_USER_TOKENを設定してください。"); }
        
        let channelName;
        let isTokenSuccessful = false;
        if (SLACK_BOT_TOKEN) {
            headers = { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' };
            try {
                const checkUrl = `https://slack.com/api/conversations.history?channel=${channelId}&limit=1`;
                const res = await fetchWithRateLimitRetry(checkUrl, { method: 'GET', headers }, 'history check');
                const data = await res.json();
                if (!data.ok) throw new Error(data.error);
                channelName = await getChannelName(channelId);
                isTokenSuccessful = true;
            } catch (error) { if (!error.message?.includes('not_in_channel') && !error.message?.includes('channel_not_found')) { throw error; } }
        }
        if (!isTokenSuccessful && SLACK_USER_TOKEN) {
            console.log("👤 ユーザートークンでチャンネル履歴へのアクセスを試行します...");
            headers = { Authorization: `Bearer ${SLACK_USER_TOKEN}`, 'Content-Type': 'application/json' };
            try {
                const checkUrl = `https://slack.com/api/conversations.history?channel=${channelId}&limit=1`;
                const res = await fetchWithRateLimitRetry(checkUrl, { method: 'GET', headers }, 'history check');
                const data = await res.json();
                if (!data.ok) throw new Error(data.error);
                channelName = await getChannelName(channelId);
                isTokenSuccessful = true;
            } catch (error) { throw error; }
        }
        if (!isTokenSuccessful) { throw new Error(`利用可能なトークンではチャンネルID "${channelId}" にアクセスできませんでした。`); }

        const allMessages = await fetchMessagesWithThreads(channelId);
        
        // 成功した場合、チャンネル名を使ってファイル名を更新
        safeName = (name || channelName).replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');
        const sourceLabel = `Slack #${channelName}`;

        const threadUrlMap = new Map();
        const threadTss = [...new Set(allMessages.filter(msg => msg.thread_ts).map(msg => msg.thread_ts))];

        for (const ts of threadTss) {
            const tsForPath = ts.replace('.', '');
            const url = `${SLACK_WORKSPACE_URL}/archives/${channelId}/p${tsForPath}?thread_ts=${ts}&cid=${channelId}`;
            threadUrlMap.set(ts, url);
        }
        
        const userMessages = allMessages.filter(msg => msg.text).sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
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
                source: sourceLabel,
                raw_data: JSON.stringify(msg)
            };
        });

        csvString = stringify(records, {
            header: true,
            columns: ['user', 'text', 'ts', 'thread_ts', 'thread_url', 'source', 'raw_data']
        });

    } catch (err) {
        console.error(`❌ 処理中にエラーが発生しました: ${err.message}`);
        // エラーが発生した場合、ヘッダーのみの空のCSV文字列を作成
        csvString = stringify([], {
            header: true,
            columns: ['user', 'text', 'ts', 'thread_ts', 'thread_url', 'source', 'raw_data']
        });
        console.log('ℹ️ エラーが発生したため、ヘッダーのみの空のCSVファイルを出力します。');
    } finally {
        // try...catchの結果に関わらず、必ずファイルを出力
        filePath = `slack_${safeName}.csv`;
        // writeFileSyncは同名ファイルがあれば上書きします
        fs.writeFileSync(filePath, csvString);
        console.log(`✅ CSV出力完了: ${filePath}`);
    }

    return filePath; // 保存したファイルのパスを返す
}

// スクリプトが直接実行された場合の処理
if (require.main === module) {
    (async () => {
        const channelId = process.argv[2];
        const name = process.argv[3];
        if (!channelId) {
            console.error("❌ チャンネルIDを引数で指定してください。");
            process.exit(1);
        }
        // 関数を呼び出すだけで、ファイル保存まで実行される
        try {
            await getSlackPostsAndConvertToCsv(channelId, name);
        } catch(err) {
            // 関数内でエラーは処理されるが、念のため最終的なエラーハンドリング
            console.error(`❌ 予期せぬエラーでスクリプトが終了しました: ${err.message}`);
            process.exit(1);
        }
    })();
}

module.exports = {
    getSlackPostsAndConvertToCsv
};
