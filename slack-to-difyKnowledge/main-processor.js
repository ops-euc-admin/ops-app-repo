const { getSlackChannelTargetFromNotion } = require('./0_notion-to-slack-list');
const { getSlackPostsAndConvertToCsv } = require('./1_slack-message-get');
const { convertToDifyReadyCsv } = require('./2_dify-converter');
const { uploadCsvToDify } = require('./3_dify-uploader');
const fs = require('fs'); // CSVファイル読み込みのため追加
const csv = require('csv-parser'); // CSVパースのため追加
const { Readable } = require('stream'); // CSV文字列をストリームとして扱うため追加

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
        const { channel_id, name, knowledge_base_id, document_id } = channel;

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
            
            // 2. CSV文字列をDify用に変換する
            const difyCsv = await convertToDifyReadyCsv(slackCsv);
            console.log(`Dify用CSV文字列への変換完了: ${safeName}`);

            // 3. 変換後のCSV文字列をDifyにアップロードまたは更新する
            const uploadFileName = `${safeName}_dify_doc.csv`; 
            await uploadCsvToDify(difyCsv, knowledge_base_id, uploadFileName); // document_id は uploadOrUpdateCsvToDify 内部で処理されるため、ここでは渡さない
            console.log(`Difyへのアップロード/更新完了: ${uploadFileName}`);

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
    // node main-processor.js [channels_csv_file_path]
    const channelsCsvFilePath = process.argv[2];

    async function main() {
        let channelsToProcess = [];

        if (channelsCsvFilePath) {
            // CSVファイルパスが指定された場合、CSVファイルからチャンネル情報を読み込む
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
                            // CSVの各行をchannelsToProcessに追加
                            // CSVのヘッダー名がオブジェクトのキーになることを想定
                            channelsToProcess.push({
                                channel_id: row.channel_id,
                                name: row.name,
                                knowledge_base_id: row.knowledge_base_id,
                                document_id: row.document_id || null // document_idはオプション
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
            // CSVファイルパスが指定されていない場合、Notionからチャンネル情報を取得
            console.log('CSVファイルパスが指定されていないため、Notionからチャンネル情報を取得します。');
            console.log('使用法: node main-processor.js [channels_csv_file_path]');
            
            try {
                // Notionからチャンネル情報を取得する関数を呼び出す
                // getSlackChannelTargetFromNotion は、channelsToProcess と同じ形式の配列を返すと想定
                channelsToProcess = await getSlackChannelTargetFromNotion();
                console.log(`Notionから ${channelsToProcess.length} 件のチャンネル情報を取得しました。`);
            } catch (err) {
                console.error(`❌ Notionからのチャンネル情報取得に失敗しました: ${err.message}`);
                process.exit(1); // 取得失敗時は処理を終了
            }
        }

        // 処理を開始
        processChannels(channelsToProcess).catch(console.error);
    }

    main().catch(console.error);
}
