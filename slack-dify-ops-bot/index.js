import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import fetch from 'node-fetch';
import { LogLevel } from '@slack/logger';
import FormData from 'form-data';
import axios from 'axios';

const app = new App({
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    token: process.env.SLACK_BOT_TOKEN,
    logLevel: LogLevel.DEBUG,
});

const conversationStore = {};

// ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
//
//               ハイブリッド対応・非同期処理アーキテクチャ
//
// ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★


/**
 * 【ステップ1】DifyのストリーミングAPIを呼び出し、思考プロセスを表示し、会話IDを取得する
 */
async function attemptStreaming({ client, pendingTs, channelId, userText, userId, conversationId, difyFilesPayload }) {
    console.log(`[STREAMING] ストリーミング処理を開始します。`);
    let fullAnswer = "";
    let newConversationId = conversationId;
    let lastUpdateTime = 0;
    const updateInterval = 1500;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1800000); // 30分

    try {
        const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DIFY_API_KEY}` },
            body: JSON.stringify({
                inputs: { "uploaded_files": difyFilesPayload || [] },
                query: userText,
                response_mode: "streaming",
                conversation_id: conversationId,
                user: userId
            }),
            signal: controller.signal
        });

        if (!response.ok) throw new Error(`Dify APIエラー: ${response.status}`);

        for await (const chunk of response.body) {
            const lines = chunk.toString().split('\n').filter(line => line.startsWith('data: '));

            for (const line of lines) {
                try {
                    const jsonData = JSON.parse(line.substring(6));
                    if (jsonData.event === 'agent_thought' && jsonData.thought) {
                        fullAnswer += jsonData.thought.replace(/\[(.*?)\].*?\(.*?\)/g, '$1') + '\n';
                    } else if (jsonData.event === 'message' && jsonData.answer) {
                        fullAnswer += jsonData.answer;
                    }
                    if (jsonData.conversation_id) newConversationId = jsonData.conversation_id;
                } catch (e) { /* ignore */ }
            }

            if (Date.now() - lastUpdateTime > updateInterval) {
                const displayText = formatForSlack(fullAnswer.substring(0, 2500)) + '...';
                await client.chat.update({
                    channel: channelId,
                    ts: pendingTs,
                    text: displayText,
                });
                lastUpdateTime = Date.now();
            }
        }
    } catch (error) {
        console.warn(`[STREAMING] ストリーミング中にエラーまたは切断が発生しました: ${error.message}`);
    } finally {
        clearTimeout(timeoutId);
    }
    
    console.log(`[STREAMING] 処理終了。会話ID: ${newConversationId} を取得しました。`);
    // この関数の主な役割は会話IDを返すこと
    return { conversationId: newConversationId };
}


/**
 * 【ステップ2】最終回答を取得するためのブロッキングAPIを呼び出す
 */
async function fetchFinalAnswer({ client, channelId, userId, userText, conversationId, difyFilesPayload }) {
    console.log(`[BLOCKING] ブロッキングモードで最終回答を確実に取得します。`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1800000); // 30分

    try {
        const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DIFY_API_KEY}` },
            body: JSON.stringify({
                inputs: { "uploaded_files": difyFilesPayload || [] },
                query: "直前の回答を取得できなかったので、もう一度、全く同じ回答をそのまま再度記載してください。",
                response_mode: "blocking",
                conversation_id: conversationId,
                user: userId
            }),
            signal: controller.signal
        });
        if (!response.ok) {
             const errorBody = await response.text();
            throw new Error(`Dify APIエラー: Status ${response.status}, Body: ${errorBody}`);
        }
        const result = await response.json();
        return { success: true, fullAnswer: result.answer, conversationId: result.conversation_id };
    } catch (error) {
         console.error(`[BLOCKING] ブロッキングでの取得中にエラー: ${error.message}`);
        return { success: false, fullAnswer: error.message, conversationId };
    } finally {
        clearTimeout(timeoutId);
    }
}


/**
 * 【ステップ3】最終的な回答を安全にSlackに投稿する
 * ★★★ 「処理中」のメッセージを更新する代わりに削除するように変更 ★★★
 */
async function postFinalAnswer({ client, pendingTs, channelId, threadTs, fullAnswer }) {
    // 最初に投稿した「処理中」のメッセージを削除
    try {
        await client.chat.delete({
            channel: channelId,
            ts: pendingTs,
        });
        console.log(`[POSTING] '処理中'のメッセージ(ts: ${pendingTs})を削除しました。`);
    } catch (e) {
        // メッセージがすでに手動で削除されている場合など、失敗しても処理は継続
        console.warn(`[POSTING] '処理中'のメッセージの削除に失敗しました: ${e.message}`);
    }

    // 分割した回答をすべて新しいメッセージとして投稿
    const messages = splitMessage(fullAnswer);
    
    for (const message of messages) {
        await client.chat.postMessage({
            channel: channelId,
            text: message,
            blocks: convertDifyAnswerToSlackBlocks(message),
            thread_ts: threadTs
        });
    }
}


/**
 * 時間のかかるDifyへの問い合わせ全体のオーケストレーター
 */
async function runDifyTaskInBackground({ client, pendingTs, channelId, threadTs, userId, userText, difyFilesPayload }) {
    const conversationKey = `${channelId}-${threadTs}`;
    const initialConversationId = conversationStore[conversationKey] || "";

    // ステップ1：ストリーミングを試み、思考プロセスを表示し、会話IDを取得する
    const streamResult = await attemptStreaming({
        client, pendingTs, channelId, userText, userId, 
        conversationId: initialConversationId, 
        difyFilesPayload
    });

    // ステップ2：ストリーミングの結果に関わらず、ブロッキングで最終回答を確実に取得する
    await client.chat.update({
        channel: channelId, ts: pendingTs,
        text: "...最終的な回答をまとめています...",
    });

    const finalResult = await fetchFinalAnswer({
        client, channelId, userId, userText,
        conversationId: streamResult.conversationId, // ストリーミングで取得した最新の会話IDを使用
        difyFilesPayload
    });

    if (finalResult.conversationId) {
        conversationStore[conversationKey] = finalResult.conversationId;
    }

    // ステップ3：最終的な回答を投稿
    if (finalResult.success && finalResult.fullAnswer && finalResult.fullAnswer.trim() !== '') {
        await postFinalAnswer({
            client, pendingTs, channelId, threadTs,
            fullAnswer: formatForSlack(finalResult.fullAnswer)
        });
        console.log(`[BACKGROUND] ✅ Difyからの回答を正常に投稿しました。`);
    } else {
        const failureReason = !finalResult.success ? "APIエラーまたはタイムアウト" : "回答が空でした";
        console.error(`[BACKGROUND] ❌ 最終的な回答の取得に失敗しました。理由: ${failureReason}`);
        await client.chat.update({
            channel: channelId, ts: pendingTs,
            text: `すみません、AIとの連携処理でエラーが発生しました。\n\`\`\`${finalResult.fullAnswer || '不明なエラー'}\`\`\``
        });
    }
}


/**
 * メインのイベントハンドラ
 */
async function processEvent({ event, client, context }) {
    if (event.bot_id) return;

    const userText = (event.text || '').replace(/<@U[0-z]+>\s*/, '').trim();
    const userId = event.user;
    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;

    let difyFilesPayload = [];
    const hasFiles = event.files && event.files.length > 0;

    if (hasFiles) {
        console.log(`[EVENT] ${event.files.length}個のファイルを処理します...`);
        try {
            const uploadPromises = event.files.map(async (file) => {
                if (!file.url_private_download) return null;
                const fileBuffer = await downloadFile(file.url_private_download, context.botToken);
                const difyUploadResult = await uploadFileToDify(fileBuffer, file.name, userId, process.env.DIFY_API_KEY);
                return {
                    type: getDifyFileType(file.mimetype),
                    transfer_method: 'local_file',
                    upload_file_id: difyUploadResult.id
                };
            });
            difyFilesPayload = (await Promise.all(uploadPromises)).filter(p => p !== null);
            console.log('[EVENT] 全てのファイルのDifyへのアップロードが完了しました。');
        } catch (error) {
            console.error('[EVENT] ファイル処理中にエラー:', error);
            await client.chat.postMessage({
                channel: channelId,
                text: `ファイルのアップロード処理中にエラーが発生しました: ${error.message}`,
                thread_ts: threadTs
            });
            return;
        }
    }

    if (!userText && !hasFiles) return;

    const pending = await client.chat.postMessage({
        channel: channelId,
        text: "...",
        thread_ts: threadTs,
    });

    runDifyTaskInBackground({
        client, pendingTs: pending.ts, channelId, threadTs, userId, userText, difyFilesPayload
    });
}


// イベントリスナー
app.event('app_mention', async ({ event, client, context }) => {
    await processEvent({ event, client, context });
});

app.message(async ({ message, client, context }) => {
    if (message.channel_type === 'im' && !message.bot_id) {
        await processEvent({ event: message, client, context });
    }
});


// 起動処理
(async () => {
    try {
        await app.start();
        console.log('⚡️ 最終版Dify連携ボット(ハイブリッド対応)が起動しました！！');
    } catch (err) {
        console.error('[FATAL] Slackアプリ起動時エラー:', err);
        process.exit(1);
    }
})();


// 接続・切断時のログ
app.receiver.client.on('connected', () => console.log('[INFO] Slackに正常に接続されました。'));
app.receiver.client.on('disconnected', (err) => console.error('[WARN] Slackとの接続が切れました:', err));
process.on('uncaughtException', (err) => console.error('[FATAL] 未処理例外:', err));


// ヘルパー関数群
function convertDifyAnswerToSlackBlocks(textContent) {
    return [{
        "type": "section",
        "text": { "type": "mrkdwn", "text": textContent }
    }];
}

function splitMessage(text, maxLength = 1500) {
    if (text.length <= maxLength) return [text];
    const result = [];
    let currentIndex = 0;
    while (currentIndex < text.length) {
        let endIndex = currentIndex + maxLength;
        if (endIndex >= text.length) {
            result.push(text.substring(currentIndex));
            break;
        }
        let splitPos = text.lastIndexOf('\n', endIndex);
        if (splitPos <= currentIndex) splitPos = text.lastIndexOf('。', endIndex) + 1;
        if (splitPos <= currentIndex) splitPos = endIndex;
        result.push(text.substring(currentIndex, splitPos));
        currentIndex = splitPos;
    }
    return result;
}

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

async function downloadFile(fileUrl, token) {
    const response = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'arraybuffer',
        headers: { 'Authorization': `Bearer ${token}` },
    });
    return Buffer.from(response.data);
}

async function uploadFileToDify(fileBuffer, fileName, user, difyApiKey) {
    const formData = new FormData();
    formData.append('user', user);
    formData.append('file', fileBuffer, { filename: fileName });

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
}

function getDifyFileType(mimetype) {
    if (!mimetype) return 'document';
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype.startsWith('video/')) return 'video';
    return 'document';
}

