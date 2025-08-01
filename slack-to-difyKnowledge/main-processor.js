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
        const { channel_id, name, knowledge_base_id, document_id } = channel; // document_id を追加

        try {
            console.log(`\n--- ${name} (${channel_id}) の処理を開始します ---`);
            
            // 1. Slackから投稿を取得し、CSV文字列を受け取る
            const { csvString: slackCsv, safeName } = await getSlackPostsAndConvertToCsv(channel_id, name);
            console.log(`Slackデータ取得とCSV文字列生成完了: ${safeName}`);
            
            // 2. CSV文字列をDify用に変換する
            const difyCsv = await convertToDifyReadyCsv(slackCsv);
            console.log(`Dify用CSV文字列への変換完了: ${safeName}`);

            // 3. 変換後のCSV文字列をDifyにアップロードまたは更新する
            const uploadFileName = `${safeName}_dify_doc.csv`; 
            await uploadCsvToDify(difyCsv, knowledge_base_id, uploadFileName, document_id); // document_id を渡す
            console.log(`Difyへの${document_id ? '更新' : '新規アップロード'}完了: ${uploadFileName}`);

            console.log(`--- ${name} の処理が完了しました ---`);
            
        } catch (error) {
            console.error(`\n❌ ${name} の処理に失敗しました: ${error.message}`);
        }
    }
}

// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node main-processor.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    // コマンドライン引数を解析
    // node main-processor.js <channel_id> <name> <knowledge_base_id> [document_id]
    const cliChannelId = process.argv[2];
    const cliName = process.argv[3];
    const cliKnowledgeBaseId = process.argv[4];
    const cliDocumentId = process.argv[5]; // オプションのドキュメントID

    let channelsToProcess = [];

    if (cliChannelId && cliName && cliKnowledgeBaseId) {
        // コマンドライン引数がすべて指定された場合、その情報でリストを構築
        console.log('コマンドライン引数からチャンネル情報を取得します。');
        channelsToProcess.push({
            channel_id: cliChannelId,
            name: cliName,
            knowledge_base_id: cliKnowledgeBaseId,
            document_id: cliDocumentId // コマンドライン引数から取得したIDを渡す
        });
    } else {
        // コマンドライン引数が不足している場合、ハードコードされたリストを使用
        console.log('コマンドライン引数が不足しているため、ハードコードされたチャンネル情報を使用します。');
        console.log('使用法 (新規作成): node main-processor.js <channel_id> <name> <knowledge_base_id>');
        console.log('使用法 (更新):   node main-processor.js <channel_id> <name> <knowledge_base_id> <document_id>');
        
        // 処理するチャンネルとナレッジベースIDのリスト (ハードコードされたもの)
        channelsToProcess = [
            // 新規作成の例
            { channel_id: 'C07A5QD6Q02', name: 'corp-ops-rev3104', knowledge_base_id: 'c8914cc6-2c6c-42da-a8ac-19802be06fd2' },
            // 更新の例 (document_id を追加)
            { channel_id: 'C088N1G5M63', name: 'ub-minop', knowledge_base_id: 'cc7be45e-1f39-4f05-b3ed-29849125f1e5', document_id: 'YOUR_EXISTING_DOCUMENT_ID' },
            // ここに実際のスプレッドシートから取得したデータを設定する
        ];
    }

    // 処理を開始
    processChannels(channelsToProcess).catch(console.error);
}
