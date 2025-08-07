import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import fetch from 'node-fetch';
import { LogLevel } from '@slack/logger';
import FormData from 'form-data'; // Difyへのファイルアップロードに必要
import axios from 'axios'; // Slackからのファイルダウンロードに利用
import fs from 'fs/promises'; // テスト用にfs/promisesをインポート
import path from 'path'; // テスト用にpathをインポート

const app = new App({
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    token: process.env.SLACK_BOT_TOKEN,
    logLevel: LogLevel.DEBUG,
});

// 会話IDを一時的に保存するためのメモリ上のストア
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
 * @param {Array<object>} [params.files] - Difyに送信するファイルオブジェクトの配列
 */
async function callDifyChatApi({ event, client, overrideText, files }) {
    // メッセージのテキストから、メンション部分を綺麗に取り除く
    const userText = overrideText || (event.text || '').replace(/<@U[0-9A-Z]+>\s*/, '').trim();

    const threadTs = event.thread_ts || event.ts;
    const conversationKey = `${event.channel}-${threadTs}`;

    // テキストがなく、ファイルもない場合は処理をスキップ
    if (!userText && (!files || files.length === 0)) {
        console.log('[INFO] ユーザーテキストもファイルもないためDifyへの質問をスキップします。');
        return;
    }

    const conversationId = conversationStore[conversationKey] || "";
    console.log(`[INFO] Difyへの質問: "${userText}", 会話ID: ${conversationId || '（新規）'}, ファイル数: ${files ? files.length : 0}`);

    // 仮メッセージを投稿
    const pending = await client.chat.postMessage({
        channel: event.channel,
        text: "回答準備中です。少々お待ちください。",
        thread_ts: threadTs
    });

    let parentDeleted = false;
    let parentCheckTimeout = null;

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

    const startParentCheck = async () => {
        await checkParentDeleted();
        if (!parentDeleted) {
            parentCheckTimeout = setTimeout(startParentCheck, 30000);
        }
    };

    try {
        startParentCheck();

        const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DIFY_API_KEY}` },
            body: JSON.stringify({
                inputs: {
                    "uploaded_files": files || []
                },
                query: userText,
                response_mode: "streaming",
                conversation_id: conversationId,
                user: event.user
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
        const updateInterval = 2000;

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
                    // JSONパースエラーは無視
                }
            }
            if (Date.now() - lastUpdateTime > updateInterval && !parentDeleted) {
                if (fullAnswer.trim().length > 0) {
                    const answerText = formatForSlack(fullAnswer.trim());
                    const messages = splitMessage(answerText);
                    if (messages[0] !== lastUpdateText) {
                        const blocksToUpdate = convertDifyAnswerToSlackBlocks(messages[0]);
                        await client.chat.update({
                            channel: event.channel,
                            ts: pending.ts,
                            text: messages[0],
                            blocks: blocksToUpdate,
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

        const answerText = formatForSlack(fullAnswer.trim() || "（AIから有効な回答を得られませんでした）");
        const messages = splitMessage(answerText);

        if (!parentDeleted) {
            const finalBlocksForFirstPart = convertDifyAnswerToSlackBlocks(messages[0]);
            if (messages.length === 1) {
                finalBlocksForFirstPart.push({ "type": "divider" });
            }
            await client.chat.update({
                channel: event.channel,
                ts: pending.ts,
                text: messages[0],
                blocks: finalBlocksForFirstPart,
                thread_ts: threadTs
            });
        }

        for (let i = 1; i < messages.length; i++) {
            if (parentDeleted) break;
            const blocksForSubsequentPart = convertDifyAnswerToSlackBlocks(messages[i]);
            if (i === messages.length - 1) {
                blocksForSubsequentPart.push({ "type": "divider" });
            }
            await client.chat.postMessage({
                channel: event.channel,
                text: messages[i],
                blocks: blocksForSubsequentPart,
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
            text: `すみません、AIとの連携処理でエラーが発生しました！\n\`\`\`${error.message}\`\`\``,
            thread_ts: threadTs
        });
    } finally {
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
        .replace(/^[*-] (.*)$/gm, '- $1')
        .replace(/\*\*([^\*]+?)\*\*/g, '*$1*')
        .replace(/^###### (.*)$/gm, '*$1*')
        .replace(/^##### (.*)$/gm, '*$1*')
        .replace(/^#### (.*)$/gm, '*$1*')
        .replace(/^### (.*)$/gm, '*$1*')
        .replace(/^## (.*)$/gm, '*$1*')
        .replace(/^# (.*)$/gm, '*$1*')
        .replace(/^[*]{3,}$/gm, '');
}

/**
 * Slackからファイルをダウンロードする関数
 * @param {string} fileUrl - ダウンロードするファイルのプライベートURL
 * @param {string} token - Slackボットトークン
 * @returns {Promise<Buffer>} ファイルのBuffer
 */
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

/**
 * ファイルをDifyにアップロードする関数
 * @param {Buffer} fileBuffer - アップロードするファイルのBuffer
 * @param {string} fileName - 元のファイル名
 * @param {string} user - SlackユーザーID
 * @param {string} difyApiKey - DifyのAPIキー
 * @returns {Promise<object>} Difyからのアップロード結果
 */
async function uploadFileToDify(fileBuffer, fileName, user, difyApiKey) {
    const formData = new FormData();
    formData.append('user', user);
    formData.append('file', fileBuffer, { filename: fileName });

    try {
        const response = await fetch('https://dify.app.uzabase.com/v1/files/upload', {
            method: 'POST',
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${difyApiKey}`
            },
            body: formData
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Dify API Error (upload): Status ${response.status}, Body: ${errorBody}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error uploading file to Dify: ${fileName}`, error);
        throw new Error(`Failed to upload file to Dify: ${fileName}`);
    }
}

/**
 * ★ 新規追加: ファイルのMIMEタイプからDify用のファイルタイプを決定するヘルパー関数
 * @param {string} mimetype - ファイルのMIMEタイプ (e.g., 'image/png', 'application/pdf')
 * @returns {string} 'image', 'audio', 'video', または 'document'
 */
function getDifyFileType(mimetype) {
    if (!mimetype) return 'document';
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype.startsWith('video/')) return 'video';
    return 'document';
}

/**
 * ★ 修正: 複数のローカルファイルのアップロードをテストする関数
 * @param {Array<string>} localFilePaths - テストしたいローカルファイルのパスの配列
 */
async function testLocalFileUpload(localFilePaths) {
    console.log(`[TEST] ローカルファイルテストを開始: ${localFilePaths.join(', ')}`);
    try {
        const user = 'local-test-user';

        const uploadPromises = localFilePaths.map(async (localFilePath) => {
            const fileBuffer = await fs.readFile(localFilePath);
            const fileName = path.basename(localFilePath);
            console.log(`[TEST] ファイル読み込み完了: ${fileName}`);
            return uploadFileToDify(fileBuffer, fileName, user, process.env.DIFY_API_KEY);
        });

        const difyUploadResults = await Promise.all(uploadPromises);
        console.log('[TEST] Difyへの全ファイルアップロード成功');

        const difyFilesPayload = difyUploadResults.map(result => ({
            type: getDifyFileType(result.mime_type),
            transfer_method: 'local_file',
            upload_file_id: result.id
        }));

        console.log('[TEST] DifyチャットAPIにテストクエリを送信します...');
        const testQuery = `アップロードしたファイル群について、それぞれ内容を要約してください。`;
         console.log(difyFilesPayload);
        
        const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DIFY_API_KEY}` },
            body: JSON.stringify({
                inputs: {
                    "uploaded_files": difyFilesPayload
                },
                query: testQuery,
                response_mode: "blocking",
                conversation_id: "",
                user: user,
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Dify APIエラー (テストチャット): Status ${response.status}, Body: ${errorBody}`);
        }

        const result = await response.json();
        console.log('[TEST] Difyからのテスト応答:', result.answer);

    } catch (error) {
        console.error('[TEST] ローカルファイルテスト中にエラーが発生しました:', error);
    }
}


// メンション、DM、ファイル共有を単一のハンドラで処理
app.message(async ({ message, client, context, logger }) => {
    // ボット自身のメッセージは無視
    if (message.bot_id) {
        return;
    }

    // メンション、DM、またはファイル共有があった場合に処理
    const isDirectMessage = message.channel_type === 'im' || message.channel_type === 'mpim';
    const isMentioned = message.text && message.text.includes(`<@${context.botUserId}>`);
    const hasFiles = message.files && message.files.length > 0;

    if (isDirectMessage || isMentioned || hasFiles) {
        let difyFilesPayload = [];

        try {
            if (hasFiles) {
                logger.info(`${message.files.length}個のファイルを処理します...`);
                
                // Promise.allで全ファイルを並行してアップロード
                const uploadPromises = message.files.map(async (file) => {
                    if (!file.url_private_download) {
                        logger.warn(`ファイル ${file.name} にダウンロードURLがありません。スキップします。`);
                        return null;
                    }
                    // 1. Slackからダウンロード
                    const fileBuffer = await downloadFile(file.url_private_download, context.botToken);

                    // 2. Difyにアップロード
                    const difyUploadResult = await uploadFileToDify(fileBuffer, file.name, message.user, process.env.DIFY_API_KEY);

                    // 3. Dify API用のペイロードを作成
                    // ★ 修正点: MIMEタイプに基づいてファイルタイプを動的に決定
                    const fileType = getDifyFileType(file.mimetype);
                    return {
                        type: fileType,
                        transfer_method: 'local_file',
                        upload_file_id: difyUploadResult.id
                    };
                });

                difyFilesPayload = (await Promise.all(uploadPromises)).filter(p => p !== null);
                logger.info('全てのファイルのアップロードが完了しました。');
            }

            // Dify APIを呼び出す
            await callDifyChatApi({
                event: message,
                client: client,
                files: difyFilesPayload
            });

        } catch (error) {
            logger.error('ファイル処理またはDify連携でエラーが発生しました:', error);
            await client.chat.postMessage({
                channel: message.channel,
                text: `処理中にエラーが発生しました: ${error.message}`,
                thread_ts: message.thread_ts || message.ts
            });
        }
    }
});


// 接続確立・切断時のログ出力
app.receiver.client.on('connected', () => {
    console.log('[INFO] socket-mode:SocketModeClient:0 正常にSlackに接続されました。');
});

app.receiver.client.on('disconnected', (event) => {
    console.error(`[WARN] Slackとの接続が切れました。理由: ${event.reason || '不明'}`);
    if (event.reason === 'link_disabled') {
        console.error('[FATAL] 回復不能なエラーのため、プロセスを終了します。Slackアプリの設定を確認してください。');
        process.exit(1);
    } else {
        console.log('[INFO] Slackとの接続が切れましたが、自動再接続を試みます...');
    }
});

(async () => {
    try {
        await app.start();
        console.log('⚡️ 本番用Dify連携ボットが起動しました！！');
        
        // ★ テスト用: 複数・多種類のローカルファイルアップロードのテストを実行
        // 使用するには、プロジェクトのルートにテストしたいファイルを配置し、
        // 以下の行のコメントを解除してファイルパスの配列を指定してください。
        //await testLocalFileUpload(['./Ops起案・案件管理.pdf', './レコーディング 2025-08-07 070852.mp4']); 
        //await testLocalFileUpload(['./レコーディング 2025-08-07 070852.mp4','./Ops起案・案件管理.pdf']); 

    } catch (err) {
        console.error('[FATAL] Slackアプリ起動時エラー:', err);
        process.exit(1);
    }
})();

process.on('uncaughtException', (err) => {
    console.error('[FATAL] 未処理例外:', err);
    process.exit(1);
});
