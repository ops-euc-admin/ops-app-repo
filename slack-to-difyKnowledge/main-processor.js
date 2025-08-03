const { getSlackChannelTargetFromNotion } = require('./0_notion-to-slack-list');
const { getSlackPostsAndConvertToCsv } = require('./1_slack-message-get');
const { convertToDifyReadyCsv } = require('./2_slack-to-dify-converter');
const { uploadCsvToDify } = require('./3_dify-uploader');
const fs = require('fs');
const csv = require('csv-parser');
const { Readable } = require('stream');

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

        // 必須フィールドのチェック
        if (!channel_id || !name || !knowledge_base_id) {
            console.error(`❌ 不足している情報があります。この行の処理をスキップします: ${JSON.stringify(channel)}`);
            continue; // 次のチャンネルへ
        }

        try {
            console.log(`\n--- ${name} (${channel_id}) の処理を開始します ---`);
            
            // 1. Slackから投稿を取得し、CSV文字列を受け取る
            const { csvString: slackCsv, safeName } = await getSlackPostsAndConvertToCsv(channel_id, name);
            console.log(`Slackデータ取得とCSV文字列生成完了: ${safeName}`);
            
            // 2. CSV文字列をDify用に変換し、"分割されたCSV文字列の配列"を受け取る
            const difyCsvParts = await convertToDifyReadyCsv(slackCsv);
            console.log(`Dify用CSVへの変換と分割完了: ${safeName} (${difyCsvParts.length}個のパーツ)`);

            // 3. 分割された各CSVをDifyにアップロードまたは更新する
            for (let i = 0; i < difyCsvParts.length; i++) {
                const partCsv = difyCsvParts[i];
                // 複数のパーツがある場合のみ `_partX` を付け、パーツが1つの場合は元のファイル名を使う
                const uploadFileName = difyCsvParts.length > 1
                    ? `${safeName}_dify_doc_part${i + 1}.csv`
                    : `${safeName}_dify_doc.csv`;

                await uploadCsvToDify(partCsv, knowledge_base_id, uploadFileName);
                console.log(`Difyへのアップロード/更新完了: ${uploadFileName}`);
            }

            console.log(`--- ${name} の処理が完了しました ---`);
            
        } catch (error) {
            console.error(`\n❌ ${name} の処理に失敗しました: ${error.message}`);
        }
    }
}

// --- コマンドラインからの独立実行用の部分 ---
if (require.main === module) {
    const channelsCsvFilePath = process.argv[2];

    async function main() {
        let channelsToProcess = [];

        if (channelsCsvFilePath) {
            console.log(`CSVファイル '${channelsCsvFilePath}' からチャンネル情報を読み込みます。`);
            if (!fs.existsSync(channelsCsvFilePath)) {
                console.error(`エラー: 指定されたCSVファイルが見つかりません - ${channelsCsvFilePath}。`);
                process.exit(1);
            }
            try {
                const csvFileContent = fs.readFileSync(channelsCsvFilePath, 'utf8');
                await new Promise((resolve, reject) => {
                    Readable.from(csvFileContent)
                        .pipe(csv())
                        .on('data', (row) => {
                            channelsToProcess.push({
                                channel_id: row.channel_id,
                                name: row.name,
                                knowledge_base_id: row.knowledge_base_id,
                                document_id: row.document_id || null
                            });
                        })
                        .on('end', () => {
                            console.log(`CSVファイルから ${channelsToProcess.length} 件のチャンネル情報を読み込みました。`);
                            resolve();
                        })
                        .on('error', (err) => {
                            console.error(`CSVファイルの読み込み中にエラーが発生しました: ${err.message}`);
                            reject(err);
                        });
                });
            } catch (err) {
                console.error(`CSVファイルの処理中にエラーが発生しました: ${err.message}`);
                process.exit(1);
            }
        } else {
            console.log('CSVファイルパスが指定されていないため、Notionからチャンネル情報を取得します。');
            console.log('使用法: node main-processor.js [channels_csv_file_path]');
            
            try {
                channelsToProcess = await getSlackChannelTargetFromNotion();
                console.log(`Notionから ${channelsToProcess.length} 件のチャンネル情報を取得しました。`);
            } catch (err) {
                console.error(`❌ Notionからのチャンネル情報取得に失敗しました: ${err.message}`);
                process.exit(1);
            }
        }

        processChannels(channelsToProcess).catch(console.error);
    }

    main().catch(console.error);
}
