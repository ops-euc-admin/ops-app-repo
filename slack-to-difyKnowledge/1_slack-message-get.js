// 必要なライブラリをインポート
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const fs = require('fs');
const { stringify } = require('csv-stringify'); // ファイルへのストリーミング用
const { stringify: stringifySync } = require('csv-stringify/sync'); // 文字列への同期変換用
const pLimit = require('p-limit').default;

// .envファイルから環境変数を読み込む
dotenv.config();

// 環境変数から定数を設定
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
const INCLUDE_THREADS = process.env.INCLUDE_THREADS === 'true';
const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL;

// ヘッダー情報を格納する変数
let headers;

/**
 * Slack APIへのリクエストをレート制限を考慮して実行します。
 * 429エラーを受け取った場合、API指定の秒数待機してリトライします。
 * @param {string} url - リクエスト先のURL
 * @param {object} options - fetchのオプション
 * @param {string} [label=''] - ログ出力用のラベル
 * @returns {Promise<Response>} fetchのレスポンスオブジェクト
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
 * チャンネルIDからチャンネル名を取得します。
 * @param {string} channelId - チャンネルID
 * @returns {Promise<string>} チャンネル名
 */
async function getChannelName(channelId) {
    const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.info?channel=${channelId}`, { method: 'GET', headers }, 'channel info');
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error (channel info): ${data.error}`);
    return data.channel.name;
}


/**
 * 指定されたSlackチャンネルから投稿を取得し、CSVを生成します。
 * 予防的な待機（スロットリング）を実装済みです。
 * @param {string} channelId チャンネルID
 * @param {string} [name] ファイル名に使用する名前（オプション）
 * @param {object} [options] オプション { output: 'file' | 'string' }
 * @returns {Promise<string>} ファイル保存の場合はファイルパス、文字列の場合はCSVデータ
 */
async function getSlackPostsAndConvertToCsv(channelId, name, options = {}) {
    const { output = 'file' } = options; // デフォルトはファイル出力

    // --- 認証とチャンネル情報の取得 ---
    if (!channelId) { throw new Error("チャンネルIDが指定されていません。"); }
    if (!SLACK_WORKSPACE_URL) { throw new Error(".envファイルにSLACK_WORKSPACE_URL（例: https://your-workspace.slack.com）を設定してください。"); }
    if (!SLACK_BOT_TOKEN && !SLACK_USER_TOKEN) { throw new Error(".envファイルにSLACK_BOT_TOKENまたはSLACK_USER_TOKENを設定してください。"); }
    
    let channelName;
    let isTokenSuccessful = false;
    if (SLACK_BOT_TOKEN) {
        headers = { Authorization: `Bearer ${SLACK_BOT_TOKEN}` };
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
        headers = { Authorization: `Bearer ${SLACK_USER_TOKEN}` };
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
    
    const safeName = (name || channelName).replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');
    const sourceLabel = `Slack #${channelName}`;

    if (output === 'file') {
        // --- ファイルへのストリーミング出力 ---
        const filePath = `slack_${safeName}.csv`;
        const stringifier = stringify({
            header: true,
            columns: ['user', 'text', 'ts', 'thread_ts', 'thread_url', 'source', 'raw_data']
        });
        const writableStream = fs.createWriteStream(filePath);
        stringifier.pipe(writableStream);

        try {
            console.log(`[1/3] スレッド情報を収集しています...`);
            const threadTsToFetch = new Set();
            let cursor = null;
            let hasMore = true;
            while(hasMore) {
                const params = new URLSearchParams({ channel: channelId, limit: '200' });
                if (cursor) params.append('cursor', cursor);
                const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.history?${params.toString()}`, { method: 'GET', headers }, 'history-scan');
                const data = await res.json();
                if (!data.ok) throw new Error(`Slack API error (history scan): ${data.error}`);
                data.messages.forEach(msg => {
                    if(msg.thread_ts) threadTsToFetch.add(msg.thread_ts);
                });
                hasMore = data.has_more;
                cursor = data.response_metadata?.next_cursor;
                if (hasMore) {
                    await new Promise(resolve => setTimeout(resolve, 1200)); // Tier 3 (50回/分)を考慮
                }
            }
            console.log(`✅ ${threadTsToFetch.size}件のスレッド情報を収集しました。`);
    
            const threadUrlMap = new Map();
            for (const ts of threadTsToFetch) {
                const tsForPath = ts.replace('.', '');
                const url = `${SLACK_WORKSPACE_URL}/archives/${channelId}/p${tsForPath}?thread_ts=${ts}&cid=${channelId}`;
                threadUrlMap.set(ts, url);
            }
    
            console.log(`[2/3] メインの投稿を取得・書き込みしています...`);
            const writtenMessages = new Set();
            cursor = null;
            hasMore = true;
            let pageCount = 0; // ★ページ数をカウントする変数を追加
            let totalMessagesProcessed = 0; // ★処理済みメッセージ数をカウントする変数を追加

            while(hasMore) {
                pageCount++; // ★カウントアップ
                const params = new URLSearchParams({ channel: channelId, limit: '200' });
                if (cursor) params.append('cursor', cursor);

                // ★現在の進捗を出力
                process.stdout.write(` 📄 ページ ${pageCount} を取得中... (処理済み: ${totalMessagesProcessed}件)\r`);

                const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.history?${params.toString()}`, { method: 'GET', headers }, 'history-write');
                const data = await res.json();
                if (!data.ok) throw new Error(`Slack API error (history write): ${data.error}`);
                
                for (const msg of data.messages) {
                    if (!msg.text || writtenMessages.has(msg.ts)) continue;
                    stringifier.write({ /* ... */ });
                    writtenMessages.add(msg.ts);
                }
                
                totalMessagesProcessed += data.messages.length; // ★処理件数を加算

                hasMore = data.has_more;
                cursor = data.response_metadata?.next_cursor;
                if (hasMore) {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                }
            }
            process.stdout.write('\n'); // ★最後の改行
            console.log(`✅ メインの投稿の書き込みが完了しました。 (合計: ${totalMessagesProcessed}件)`);
    
            if (INCLUDE_THREADS && threadTsToFetch.size > 0) {
                console.log(`[3/3] ${threadTsToFetch.size}件のスレッドの返信を取得・書き込みしています...`);
                const limit = pLimit(3);
                let processedCount = 0;
                
                const MIN_INTERVAL = 3000; // 3秒 (conversations.repliesはTier 2のため)

                const promises = Array.from(threadTsToFetch).map(threadTs => limit(async () => {
                    const startTime = Date.now(); // ★★★ 開始時間を記録 ★★★
                    let repliesCursor = null; let hasMoreReplies = true;
                    while (hasMoreReplies) {
                        const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: '200' });
                        if (repliesCursor) params.append('cursor', repliesCursor);
                        const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.replies?${params.toString()}`, { method: 'GET', headers }, `replies:${threadTs}`);
                        const data = await res.json();
                        if (!data.ok) { console.warn(`スレッド返信の取得失敗 (ts: ${threadTs}): ${data.error}`); break; }
                        for (const msg of data.messages) {
                            if (!msg.text || writtenMessages.has(msg.ts)) continue;
                            stringifier.write({
                                user: msg.user || '', text: msg.text.replace(/\n/g, ' ').trim(), ts: msg.ts,
                                thread_ts: (msg.thread_ts && msg.thread_ts !== msg.ts) ? msg.thread_ts : '',
                                thread_url: msg.thread_ts ? threadUrlMap.get(msg.thread_ts) || '' : '',
                                source: sourceLabel, raw_data: JSON.stringify(msg)
                            });
                            writtenMessages.add(msg.ts);
                        }
                        hasMoreReplies = data.has_more;
                        repliesCursor = data.response_metadata?.next_cursor;
                        if (hasMoreReplies) {
                            await new Promise(resolve => setTimeout(resolve, 3000)); // Tier 2 (20回/分)を考慮
                        }
                    }
                    
                    const elapsedTime = Date.now() - startTime;
                    const delayNeeded = MIN_INTERVAL - elapsedTime;
                    if (delayNeeded > 0) {
                        await new Promise(resolve => setTimeout(resolve, delayNeeded));
                    }

                    processedCount++;
                    process.stdout.write(`  - スレッド処理中: ${processedCount} / ${threadTsToFetch.size} (${Math.round((processedCount / threadTsToFetch.size) * 100)}%)\r`);
                }));
                await Promise.all(promises);
                process.stdout.write('\n');
                console.log(`✅ スレッドの返信の書き込みが完了しました。`);
            }
        } catch (err) {
            console.error(`❌ 処理中にエラーが発生しました: ${err.message}`);
            console.log('ℹ️ エラーが発生したため、不完全な（または空の）CSVファイルが出力される可能性があります。');
        } finally {
            stringifier.end();
        }
        await new Promise(resolve => writableStream.on('finish', resolve));
        console.log(`✅ CSV出力完了: ${filePath}`);
        return filePath;

    } else {
        // --- 文字列としてのストリーミング生成 ---
        console.log('ℹ️ CSVデータを文字列としてメモリ上に生成します...');
        const stringifier = stringify({
            header: true,
            columns: ['user', 'text', 'ts', 'thread_ts', 'thread_url', 'source', 'raw_data']
        });

        let csvData = '';
        const streamPromise = new Promise((resolve, reject) => {
            stringifier.on('readable', () => {
                let row;
                while ((row = stringifier.read()) !== null) {
                    csvData += row;
                }
            });
            stringifier.on('error', reject);
            stringifier.on('finish', () => resolve(csvData));
        });

        try {
            console.log(`[1/3] スレッド情報を収集しています...`);
            const threadTsToFetch = new Set();
            let cursor = null;
            let hasMore = true;
            while(hasMore) {
                const params = new URLSearchParams({ channel: channelId, limit: '200' });
                if (cursor) params.append('cursor', cursor);
                const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.history?${params.toString()}`, { method: 'GET', headers }, 'history-scan');
                const data = await res.json();
                if (!data.ok) throw new Error(`Slack API error (history scan): ${data.error}`);
                data.messages.forEach(msg => {
                    if(msg.thread_ts) threadTsToFetch.add(msg.thread_ts);
                });
                hasMore = data.has_more;
                cursor = data.response_metadata?.next_cursor;
                if (hasMore) {
                    await new Promise(resolve => setTimeout(resolve, 1200)); // Tier 3 (50回/分)を考慮
                }
            }
            console.log(`✅ ${threadTsToFetch.size}件のスレッド情報を収集しました。`);
    
            const threadUrlMap = new Map();
            for (const ts of threadTsToFetch) {
                const tsForPath = ts.replace('.', '');
                const url = `${SLACK_WORKSPACE_URL}/archives/${channelId}/p${tsForPath}?thread_ts=${ts}&cid=${channelId}`;
                threadUrlMap.set(ts, url);
            }
    
            console.log(`[2/3] メインの投稿を処理しています...`);
            const writtenMessages = new Set();
            cursor = null;
            hasMore = true;
            while(hasMore) {
                const params = new URLSearchParams({ channel: channelId, limit: '200' });
                if (cursor) params.append('cursor', cursor);
                const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.history?${params.toString()}`, { method: 'GET', headers }, 'history-write');
                const data = await res.json();
                if (!data.ok) throw new Error(`Slack API error (history write): ${data.error}`);
                
                for (const msg of data.messages) {
                    if (!msg.text || writtenMessages.has(msg.ts)) continue;
                    stringifier.write({
                        user: msg.user || '', text: msg.text.replace(/\n/g, ' ').trim(), ts: msg.ts,
                        thread_ts: (msg.thread_ts && msg.thread_ts !== msg.ts) ? msg.thread_ts : '',
                        thread_url: msg.thread_ts ? threadUrlMap.get(msg.thread_ts) || '' : '',
                        source: sourceLabel, raw_data: JSON.stringify(msg)
                    });
                    writtenMessages.add(msg.ts);
                }
                hasMore = data.has_more;
                cursor = data.response_metadata?.next_cursor;
                if (hasMore) {
                    await new Promise(resolve => setTimeout(resolve, 1200)); // Tier 3 (50回/分)を考慮
                }
            }
            console.log(`✅ メインの投稿の処理が完了しました。`);
    
            if (INCLUDE_THREADS && threadTsToFetch.size > 0) {
                console.log(`[3/3] ${threadTsToFetch.size}件のスレッドの返信を処理しています...`);
                const limit = pLimit(3);
                let processedCount = 0;
                
                const MIN_INTERVAL = 3000; // 3秒 (conversations.repliesはTier 2のため)

                const promises = Array.from(threadTsToFetch).map(threadTs => limit(async () => {
                    const startTime = Date.now(); // ★★★ 開始時間を記録 ★★★
                    let repliesCursor = null; let hasMoreReplies = true;
                    while (hasMoreReplies) {
                        const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: '200' });
                        if (repliesCursor) params.append('cursor', repliesCursor);
                        const res = await fetchWithRateLimitRetry(`https://slack.com/api/conversations.replies?${params.toString()}`, { method: 'GET', headers }, `replies:${threadTs}`);
                        const data = await res.json();
                        if (!data.ok) { console.warn(`スレッド返信の取得失敗 (ts: ${threadTs}): ${data.error}`); break; }
                        for (const msg of data.messages) {
                            if (!msg.text || writtenMessages.has(msg.ts)) continue;
                            stringifier.write({
                                user: msg.user || '', text: msg.text.replace(/\n/g, ' ').trim(), ts: msg.ts,
                                thread_ts: (msg.thread_ts && msg.thread_ts !== msg.ts) ? msg.thread_ts : '',
                                thread_url: msg.thread_ts ? threadUrlMap.get(msg.thread_ts) || '' : '',
                                source: sourceLabel, raw_data: JSON.stringify(msg)
                            });
                            writtenMessages.add(msg.ts);
                        }
                        hasMoreReplies = data.has_more;
                        repliesCursor = data.response_metadata?.next_cursor;
                        if (hasMoreReplies) {
                            await new Promise(resolve => setTimeout(resolve, 3000)); // Tier 2 (20回/分)を考慮
                        }
                    }

                    const elapsedTime = Date.now() - startTime;
                    const delayNeeded = MIN_INTERVAL - elapsedTime;
                    if (delayNeeded > 0) {
                        await new Promise(resolve => setTimeout(resolve, delayNeeded));
                    }

                    processedCount++;
                    process.stdout.write(`  - スレッド処理中: ${processedCount} / ${threadTsToFetch.size} (${Math.round((processedCount / threadTsToFetch.size) * 100)}%)\r`);
                }));
                await Promise.all(promises);
                process.stdout.write('\n');
                console.log(`✅ スレッドの返信の処理が完了しました。`);
            }
        } catch (err) {
            console.error(`❌ 文字列生成中にエラーが発生しました: ${err.message}`);
            stringifier.end(); // エラー時もストリームを終了
            throw err;
        }

        stringifier.end();
        return await streamPromise;
    }
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
        try {
            // デフォルトのファイル出力で実行
            await getSlackPostsAndConvertToCsv(channelId, name);
        } catch(err) {
            // getSlackPostsAndConvertToCsv内でエラーは処理されるが、念のため
            console.error(`❌ 予期せぬエラーでスクリプトが終了しました: ${err.message}`);
            process.exit(1);
        }
    })();
}

// 他のファイルからインポートして使用できるようにエクスポート
module.exports = {
    getSlackPostsAndConvertToCsv
};