const { getSlackPostsAndConvertToCsv } = require('./slack-messages-get'); // 既存のSlackアプリ
const { convertToDifyAndUpload } = require('./slack-messages-knowledgeForDify'); // 既存の変換アプリ

/**
 * コマンドライン引数を解析してオブジェクトに変換する関数
 * @param {string[]} args - コマンドライン引数の配列
 * @returns {Object} 解析された引数を含むオブジェクト
 */
function parseArgs(args) {
    const params = {};
    args.forEach(arg => {
        const parts = arg.split('=');
        if (parts.length === 2) {
            params[parts[0].trim()] = parts[1].trim();
        }
    });
    return params;
}

/**
 * Slackから投稿を取得し、Difyナレッジにアップロードするメイン関数
 * @param {string} channel_id - 取得するSlackチャンネルID
 * @param {string} name - 保存名（例: ファイル名の一部に使用）
 * @param {string} knowledge_base_id - アップロード先のDifyナレッジベースID
 */
// 呼び方サンプル: node index.js channelId="C12345" name="general-channel" knowledgeBaseId="kb_abcdefgh"
async function main(channel_id, name, knowledge_base_id) {
    if (!channel_id || !name || !knowledge_base_id) {
        console.error('Error: Missing required arguments.');
        console.error('Usage: node index.js channelId="C12345" name="general" knowledgeBaseId="kb_abcde"');
        process.exit(1);
    }

    try {
        console.log(`Starting process for channel: ${name} (${channel_id})`);

        // Slack投稿取得アプリを実行し、CSVデータを取得
        // ※ 既存のコードがどのようにデータを返すかによって調整してください
        const csvData = await getSlackPostsAndConvertToCsv(channel_id, name);
        console.log('Slack data successfully retrieved and converted to CSV.');

        // Difyナレッジ用データへの変換とアップロードを実行
        // ※ 既存のコードの引数や戻り値に合わせて調整してください
        await convertToDifyAndUpload(csvData, knowledge_base_id);
        console.log(`Data successfully uploaded to Dify knowledge base: ${knowledge_base_id}`);

        console.log('Process completed successfully.');

    } catch (error) {
        console.error('An error occurred during the process.');
        console.error(`Error details: ${error.message}`);
        process.exit(1);
    }
}

// スクリプトが直接実行された場合にメイン関数を呼び出す
const args = parseArgs(process.argv.slice(2));
main(args.channelId, args.name, args.knowledgeBaseId);