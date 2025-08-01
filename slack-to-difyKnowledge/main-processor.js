const { getSlackPostsAndConvertToCsv } = require('./1_slack-message-get');
const { convertToDifyReadyCsv } = require('./2_dify-converter');
const { uploadCsvToDify } = require('./3_dify-uploader');

/**
 * 複数のチャンネルをDifyナレッジベースに連携するプロセスを実行します。
 * @param {Array<Object>} channels - 処理するチャンネル情報の配列
 */
async function processChannels(channels) {
    if (!channels || channels.length === 0) {
        console.warn('処理対象のチャンネルが指定されていません。');
        return;
    }

    for (const channel of channels) {
        const { channel_id, name, knowledge_base_id } = channel;

        try {
            console.log(`\n--- Starting full process for ${name} (${channel_id}) ---`);
            
            // 1. Slackから投稿を取得し、CSV文字列を受け取る
            const { csvString: slackCsv, safeName } = await getSlackPostsAndConvertToCsv(channel_id, name);
            console.log(`Slackデータ取得とCSV文字列生成完了: ${safeName}`);
            
            // 2. CSV文字列をDify用に変換する
            const difyCsv = await convertToDifyReadyCsv(slackCsv);
            console.log(`Dify用CSV文字列への変換完了: ${safeName}`);

            // 3. 変換後のCSV文字列をDifyにアップロードする
            // Difyに登録するドキュメント名としてsafeNameを使用
            const uploadFileName = `${safeName}_dify_doc.csv`; 
            await uploadCsvToDify(difyCsv, knowledge_base_id, uploadFileName);
            console.log(`Difyへのアップロード完了: ${uploadFileName}`);

            console.log(`--- Process completed for ${name} ---`);
            
        } catch (error) {
            console.error(`\n❌ Failed to process ${name}: ${error.message}`);
        }
    }
}

// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node main-processor.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    // コマンドライン引数を解析
    // node main-processor.js <channel_id> <name> <knowledge_base_id>
    const cliChannelId = process.argv[2];
    const cliName = process.argv[3];
    const cliKnowledgeBaseId = process.argv[4];

    let channelsToProcess = [];

    if (cliChannelId && cliName && cliKnowledgeBaseId) {
        // コマンドライン引数がすべて指定された場合、その情報でリストを構築
        console.log('コマンドライン引数からチャンネル情報を取得します。');
        channelsToProcess.push({
            channel_id: cliChannelId,
            name: cliName,
            knowledge_base_id: cliKnowledgeBaseId
        });
    } else {
        // コマンドライン引数が不足している場合、ハードコードされたリストを使用
        console.log('コマンドライン引数が不足しているため、ハードコードされたチャンネル情報を使用します。');
        console.log('使用法: node main-processor.js <channel_id> <name> <knowledge_base_id>');
        
        // 処理するチャンネルとナレッジベースIDのリスト (ハードコードされたもの)
        channelsToProcess = [
            { channel_id: 'C07A5QD6Q02', name: 'corp-ops-rev3104', knowledge_base_id: 'c8914cc6-2c6c-42da-a8ac-19802be06fd2' },
            { channel_id: 'C088N1G5M63', name: 'ub-minop', knowledge_base_id: 'cc7be45e-1f39-4f05-b3ed-29849125f1e5' },
            // ここに実際のスプレッドシートから取得したデータを設定する
            // 例: { channel_id: 'YOUR_CHANNEL_ID', name: 'YOUR_CHANNEL_NAME', knowledge_base_id: 'YOUR_KNOWLEDGE_BASE_ID' },
        ];
    }

    // 処理を開始
    processChannels(channelsToProcess).catch(console.error);
}