import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import { LogLevel } from '@slack/logger';

// Slack Appの初期化
const app = new App({
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    token: process.env.SLACK_BOT_TOKEN,
    logLevel: LogLevel.DEBUG,
});

/**
 * ユーザーにボットの機能が移行したことを通知するメッセージ
 */
const MIGRATION_MESSAGE = "こちらのボット (@OpsDeepResearchは、現在「@Opsボット」に機能が移行されました。\nお手数ですが、今後は `@Opsボット` にメンションしてご利用ください。";

/**
 * イベントを処理し、案内メッセージを投稿する共通関数
 * @param {object} params
 * @param {object} params.event - Slackのイベントペイロード (`app_mention` または `message`)
 * @param {object} params.client - Slack WebClient
 * @param {object} params.logger - ロガー
 */
async function postMigrationMessage({ event, client, logger }) {
    // ボット自身のメッセージは無視する
    if (event.bot_id) {
        return;
    }

    try {
        await client.chat.postMessage({
            channel: event.channel,
            thread_ts: event.thread_ts || event.ts, // スレッド内でのやり取りに対応
            text: MIGRATION_MESSAGE
        });
        logger.info(`案内メッセージをチャンネル(${event.channel})のスレッド(${event.thread_ts || event.ts})に投稿しました。`);
    } catch (error) {
        logger.error('案内メッセージの投稿に失敗しました:', error);
    }
}

// チャンネルでメンションされた時のイベント (`app_mention`) をリッスン
app.event('app_mention', async ({ event, client, logger }) => {
    await postMigrationMessage({ event, client, logger });
});

// ダイレクトメッセージ(DM)をリッスン
app.message(async ({ message, client, logger }) => {
    // メッセージがDM (`im`) の場合のみ処理する
    if (message.channel_type === 'im') {
        // `message` オブジェクトを `event` として共通処理関数に渡す
        await postMigrationMessage({ event: message, client, logger });
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

// アプリケーションの起動
(async () => {
    try {
        await app.start();
        console.log('⚡️ Opsボット案内用ボットが起動しました！');
    } catch (err) {
        console.error('[FATAL] Slackアプリ起動時エラー:', err);
        process.exit(1);
    }
})();

// 未処理の例外をキャッチ
process.on('uncaughtException', (err) => {
    console.error('[FATAL] 未処理例外:', err);
    process.exit(1);
});
