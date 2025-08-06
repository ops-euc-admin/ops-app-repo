const fetch = require('node-fetch');
const dotenv = require('dotenv');

dotenv.config();

// ボットの招待に必須のトークンと、招待したいボットのIDを環境変数から読み込みます
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const TARGET_BOT_USER_ID = process.env.TARGET_BOT_USER_ID;

/**
 * APIリクエストがレート制限にかかった場合にリトライします。
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
 * 指定されたチャンネルにボットを招待します。
 * @param {string} channelId 招待先のチャンネルID
 */
async function inviteBotToChannel(channelId) {
    // 必要な環境変数が設定されているかチェックします
    if (TARGET_BOT_USER_ID=== '') {
        throw new Error("招待するボットのID (TARGET_BOT_USER_ID) が.envファイルに設定されていません。");
    }
    if (!SLACK_BOT_TOKEN) {
        throw new Error("招待を実行するためのボットトークン (SLACK_BOT_TOKEN) が.envファイルに設定されていません。");
    }

    console.log(`[+] ボット (ID: ${TARGET_BOT_USER_ID}) をチャンネル (ID: ${channelId}) に招待します...`);

    // 招待APIを呼び出すためのヘッダーとボディを直接作成します
    const inviteHeaders = {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
    };
    const body = new URLSearchParams({
        channel: channelId,
        users: TARGET_BOT_USER_ID
    });
    const url = 'https://slack.com/api/conversations.invite';

    try {
        const res = await fetchWithRateLimitRetry(url, {
            method: 'POST',
            headers: inviteHeaders,
            body: body.toString(),
        }, `invite:${channelId}`);
        
        const data = await res.json();

        if (data.ok) {
            console.log(`✅ ボットの招待に成功しました。`);
        } else if (data.error === 'already_in_channel') {
            console.log(`ℹ️ ボットはすでにチャンネルに参加済みです。`);
        } else {
            // not_in_channel (招待する側がいない), user_not_found (招待されるIDが違う) など
            console.warn(`⚠️ ボットの招待に失敗しました。Error: ${data.error}`);
        }
    } catch (inviteError) {
        console.error(`❌ 招待APIの呼び出し中にエラーが発生しました:`, inviteError.message);
        // エラーが発生した場合は、呼び出し元にエラーを伝播させます
        throw inviteError;
    }
    
}


/**
 * ★★★ 新機能: ボットの表示名からIDを検索します ★★★
 * @param {string} botName 検索したいボットの表示名
 */
async function findBotIdByName(botName) {
    if (!SLACK_BOT_TOKEN) {
        throw new Error("ボットを検索するためのトークン (SLACK_BOT_TOKEN) が.envファイルに設定されていません。");
    }
    console.log(`[?] 表示名 "${botName}" のボットを検索しています... (権限 users:read が必要です)`);

    const inviteHeaders = { Authorization: `Bearer ${SLACK_BOT_TOKEN}` };
    let cursor;
    let found = false;

    do {
        const params = new URLSearchParams({ limit: '200' });
        if (cursor) {
            params.append('cursor', cursor);
        }
        const url = `https://slack.com/api/users.list?${params.toString()}`;
        const res = await fetchWithRateLimitRetry(url, { headers: inviteHeaders }, 'users.list');
        const data = await res.json();

        if (!data.ok) {
            throw new Error(`Slack APIエラー (users.list): ${data.error}`);
        }

        const bot = data.members.find(member => member.is_bot && (member.profile.real_name === botName || member.name === botName));

        if (bot) {
            console.log(`✅ ボットが見つかりました！`);
            console.log(`  - 表示名: ${bot.profile.real_name}`);
            console.log(`  - ユーザー名: @${bot.name}`);
            console.log(`  - Bot User ID: ${bot.id}`);
            console.log(`  - Deactivated: ${bot.deleted}`);
            console.log(`\nこのIDを.envファイルの TARGET_BOT_USER_ID に設定してください。`);
            console.log(`Deactivatedがtrueの場合、ボットは無効化されており招待できません。管理者に確認してください。`);
            found = true;
            break;
        }

        cursor = data.response_metadata?.next_cursor;
    } while (cursor);

    if (!found) {
        console.warn(`⚠️ 表示名 "${botName}" のボットは見つかりませんでした。`);
    }
}

// このスクリプトが直接実行された場合にのみ以下の処理を行います
if (require.main === module) {
    const command = process.argv[2]; // コマンドライン引数の3番目を取得
    const argument = process.argv[3]; // コマンドライン引数の4番目を取得

    if (!command) {
        console.error("❌ コマンドを指定してください。");
        console.error("  - ID検索: node invite.js find \"ボットの表示名\"");
        console.error("  - 招待実行: node invite.js <チャンネルID>");
        process.exit(1);
    }

    if (command === 'find') {
        if (!argument) {
            console.error("❌ 検索するボットの表示名を指定してください。例: node invite.js find \"My Bot\"");
            process.exit(1);
        }
        findBotIdByName(argument).catch(err => {
            console.error(`❌ 検索中にエラーが発生しました: ${err.message}`);
            process.exit(1);
        });
    } else {
        // 'find'以外のコマンドはチャンネルIDとして扱い、招待処理を実行
        inviteBotToChannel(command).catch(err => {
            console.error(`❌ 最終エラー (チャンネルID: ${command}): ${err.message}`);
            process.exit(1);
        });
    }
}
module.exports = {
    inviteBotToChannel
};
