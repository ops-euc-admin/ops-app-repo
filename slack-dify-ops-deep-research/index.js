import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import fetch from 'node-fetch';
import { LogLevel } from '@slack/logger';

// ファイルダウンロードとS3アップロードに必要なライブラリをインポート
import axios from 'axios';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';

// AWS S3クライアントの初期化
const s3Client = new S3Client({
    region: process.env.AWS_REGION, // 環境変数からAWSリージョンを取得
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const app = new App({
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    token: process.env.SLACK_BOT_TOKEN,
    logLevel: LogLevel.DEBUG, // デバッグレベルのログを有効化
});

// 会話IDを一時的に保存するためのメモリ上のストア
// 本番環境では永続化ストア（Redis, DBなど）の利用を推奨
const conversationStore = {};

/**
 * Difyの回答テキストをSlackのBlock Kitの単一セクションブロックに変換する関数
 * @param {string} textContent - Slackのmrkdwn形式で表示するテキスト内容
 * @returns {Array<object>} Slackのblocks配列（単一のsectionブロックを含む）
 */
function convertDifyAnswerToSlackBlocks(textContent) {
    return [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": textContent
            }
        }
    ];
}

/**
 * DifyチャットAPIを呼び出し、Slackに回答を投稿する共通処理
 * @param {object} params - パラメータオブジェクト
 * @param {object} params.event - Slackイベントオブジェクト
 * @param {object} params.client - Slack WebClient
 * @param {string} [params.overrideText] - Difyに送信するテキストをevent.textの代わりに上書きする場合
 */
async function callDifyChatApi({ event, client, overrideText }) {
    // メッセージのテキストから、メンション部分を綺麗に取り除く（DMでは不要だが共通化）
    const userText = overrideText || (event.text || '').replace(/<@U[0-9A-Z]+>\s*/, '').trim();

    // スレッドの親メッセージのtsを常に使う
    const threadTs = event.thread_ts || event.ts;
    const conversationKey = `${event.channel}-${event.thread_ts || event.ts}`;

    if (!userText) {
        console.log('[INFO] ユーザーテキストが空のためDifyへの質問をスキップします。');
        return;
    }

    const conversationId = conversationStore[conversationKey] || "";
    console.log(`[INFO] Difyへの質問: "${userText}", 会話ID: ${conversationId || '（新規）'}`);

    // 仮メッセージを投稿
    const pending = await client.chat.postMessage({
        channel: event.channel,
        text: "回答準備中です。少々お待ちください。", // Fallback text for notifications
        thread_ts: threadTs
    });

    let parentDeleted = false;
    let parentCheckTimeout = null; // setIntervalの代わりにsetTimeoutを使用

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
            console.warn('[WARN] 親スレッド削除チェックでエラー:', e);
        }
    }

    // 親スレッドの削除を定期的にチェックする再帰関数
    const startParentCheck = async () => {
        await checkParentDeleted();
        if (!parentDeleted) {
            parentCheckTimeout = setTimeout(startParentCheck, 30000); // 30秒ごとに再チェック
        }
    };

    try {
        startParentCheck(); // 親スレッドチェックを開始

        const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DIFY_API_KEY}` },
            body: JSON.stringify({
                inputs: {},
                query: userText,
                response_mode: "streaming",
                conversation_id: conversationId,
                user: event.user // SlackユーザーIDをDifyのユーザーとして渡す
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Dify APIエラー: Status ${response.status}, Body: ${errorBody}`);
        }

        let fullAnswer = "";
        let newConversationId = "";
        let lastUpdateText = "";
        let lastUpdateTime = Date.now();
        const updateInterval = 2000; // 2秒ごとにSlackを更新

        // ストリーミングレスポンスの処理
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
                } catch (e) {
                    // JSONパースエラーは無視するが、デバッグのためにログ出力しても良い
                    // console.warn('[WARN] DifyストリーミングJSONパースエラー:', e.message, 'Line:', line);
                }
            }
            // 2秒ごとにSlackメッセージを更新（fullAnswerが空の間は更新しない）
            if (Date.now() - lastUpdateTime > updateInterval && !parentDeleted) {
                if (fullAnswer.trim().length > 0) {
                    const answerText = formatForSlack(fullAnswer.trim());
                    const messages = splitMessage(answerText);
                    if (messages[0] !== lastUpdateText) {
                        const blocksToUpdate = convertDifyAnswerToSlackBlocks(messages[0]); // Block Kitに変換
                        await client.chat.update({
                            channel: event.channel,
                            ts: pending.ts,
                            text: messages[0], // Fallback text for notifications
                            blocks: blocksToUpdate, // Block Kitを使用
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

        // 最終的な回答を分割して投稿
        const answerText = formatForSlack(fullAnswer.trim() || "（AIから有効な回答を得られませんでした）");
        const messages = splitMessage(answerText);

        // 1つ目は仮メッセージを上書き
        if (!parentDeleted) {
            const finalBlocksForFirstPart = convertDifyAnswerToSlackBlocks(messages[0]);
            // 最後のメッセージ部分にのみ区切り線と追加の質問ブロックを追加
            if (messages.length === 1) {
                finalBlocksForFirstPart.push(
                    { "type": "divider" }
                );
            }

            await client.chat.update({
                channel: event.channel,
                ts: pending.ts,
                text: messages[0], // Fallback text for notifications
                blocks: finalBlocksForFirstPart, // Block Kitを使用
                thread_ts: threadTs
            });
        }

        // 2つ目以降も必ず3900文字以内で投稿
        for (let i = 1; i < messages.length; i++) {
            if (parentDeleted) break;
            const blocksForSubsequentPart = convertDifyAnswerToSlackBlocks(messages[i]);
            const currentBlocks = [...blocksForSubsequentPart];
            // 最後のメッセージ部分にのみ区切り線と追加の質問ブロックを追加
            if (i === messages.length - 1) {
                currentBlocks.push(
                    { "type": "divider" }
                );
            }
            await client.chat.postMessage({
                channel: event.channel,
                text: messages[i], // Fallback text for notifications
                blocks: currentBlocks, // Block Kitを使用
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
            text: `すみません、AIとの連携処理でエラーが発生しました！\n\`\`\`${error.message}\`\`\``, // エラーメッセージも表示
            thread_ts: threadTs
        });
    } finally {
        // setTimeoutのクリアを忘れずに
        if (parentCheckTimeout) clearTimeout(parentCheckTimeout);
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

// DifyのMarkdownをSlack向けに整形する関数
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

// Slackからファイルをダウンロードする関数
async function downloadFile(fileUrl, token) {
    try {
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'arraybuffer',
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Error downloading file from Slack:', error.response ? error.response.data : error.message);
        throw new Error('Failed to download file from Slack');
    }
}

// S3にファイルをアップロードする関数
async function uploadFileToS3(fileBuffer, fileName, contentType) {
    const key = `slack-uploads/${Date.now()}-${fileName}`; // S3のキー
    const params = {
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: key,
        Body: Readable.from(fileBuffer), // BufferをReadableストリームに変換
        ContentType: contentType,
        ACL: 'public-read', // 公開アクセス可能にする（必要に応じて変更）
    };

    try {
        const uploader = new Upload({
            client: s3Client,
            params: params,
        });

        await uploader.done();
        const fileUrl = `${process.env.S3_BASE_URL}${key}`;
        return fileUrl;
    } catch (error) {
        console.error('Error uploading file to S3:', error);
        throw new Error('Failed to upload file to S3');
    }
}

// Slackでファイルがアップロードされたイベントをリッスン
app.event('file_shared', async ({ event, client, logger }) => {
    try {
        const fileInfo = await client.files.info({ file: event.file_id });
        const file = fileInfo.file;

        if (!file || !file.url_private_download) {
            logger.error('File info or download URL not found.');
            return;
        }

        await client.chat.postMessage({
            channel: event.channel_id || event.channel,
            text: `ファイル "${file.name}" を受け取りました。外部ストレージに保存しています...`,
        });

        // ファイルをダウンロード
        const fileBuffer = await downloadFile(file.url_private_download, process.env.SLACK_BOT_TOKEN);

        // S3にアップロード
        const s3FileUrl = await uploadFileToS3(fileBuffer, file.name, file.mimetype);

        await client.chat.postMessage({
            channel: event.channel_id || event.channel,
            text: `ファイル "${file.name}" がS3に保存されました: ${s3FileUrl}\nこのURLをDifyに渡します。`,
        });

        // DifyにファイルのURLを送信
        const query = `以下のURLにあるファイルについて分析してください: ${s3FileUrl}`;
        // callDifyChatApiを呼び出す際に、eventとclientを渡し、overrideTextでDifyへのクエリを指定
        await callDifyChatApi({ event, client, overrideText: query });

    } catch (error) {
        logger.error('Failed to process file_shared event:', error);
        await client.chat.postMessage({
            channel: event.channel_id || event.channel,
            text: `ファイルの処理中にエラーが発生しました: ${error.message}`,
        });
    }
});

// メンションイベント
app.event('app_mention', async ({ event, client }) => {
    await callDifyChatApi({ event, client });
});

// DMイベント
app.event('message', async ({ event, client }) => {
    if (event.channel_type === 'im' && !event.bot_id) {
        await callDifyChatApi({ event, client });
    }
});

// 接続が確立したとき
app.receiver.client.on('connected', () => {
    console.log('[INFO] socket-mode:SocketModeClient:0 正常にSlackに接続されました。');
});

// Slackとの接続が切れたとき
app.receiver.client.on('disconnected', (event) => {
    // SocketModeClientはデフォルトで自動再接続を試みるため、
    // ここで手動で app.start() を呼び出す必要はありません。
    // 手動で呼び出すと、ステートマシンが予期しない状態になる可能性があります。
    console.error(`[WARN] Slackとの接続が切れました。理由: ${event.reason}`);

    // 致命的なエラー（例：トークン無効）でなければ、SocketModeClientの自動再接続に任せる
    // 'link_disabled' はApp-Level Tokenが無効化された場合など、回復不能なエラー
    if (event.reason === 'link_disabled') {
        console.error('[FATAL] 回復不能なエラーのため、プロセスを終了します。Slackアプリの設定を確認してください。');
        process.exit(1);
    } else {
        console.log('[INFO] Slackとの接続が切れましたが、自動再接続を試みます...');
        // ここで手動の再接続ロジック（setTimeoutとapp.start()）は削除
    }
});

(async () => {
    try {
        await app.start();
        console.log('⚡️ 本番用Dify連携ボットが起動しました！！');
    } catch (err) {
        console.error('[FATAL] Slackアプリ起動時エラー:', err);
        process.exit(1);
    }
})();

// Socket Modeの致命的エラー時に自動再起動できるように
process.on('uncaughtException', (err) => {
    console.error('[FATAL] 未処理例外:', err);
    process.exit(1);
});
