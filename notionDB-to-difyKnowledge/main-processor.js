const { getNotionDBTargetFromNotion } = require('./0_notion-to-notion-list');
const { getNotionPostsAndConvertToCsv } = require('./1_notionDB-get');
const { convertToDifyReadyCsv } = require('./2_notionDB-to-dify-converter');
const { uploadCsvToDify } = require('./3_dify-uploader');
const fs = require('fs');
const csv = require('csv-parser');
const { Readable } = require('stream');

/**
 * 複数のnotionDBをDifyナレッジベースに連携するプロセスを実行します。
 * @param {Array<Object>} notionDBs - 処理するnotionDB情報の配列
 */
async function processNotionDBs(notionDBs) {
    if (!notionDBs || notionDBs.length === 0) {
        console.warn('処理対象のnotionDBが指定されていません。');
        return;
    }

    for (const notionDB of notionDBs) {
        // ★ 修正点: 0_notion-to-notion-list.js から渡されるキー名 'notionDB_id' に合わせる
        const { notionDB_id, name, knowledge_base_id } = notionDB;

        // 必須フィールドのチェック
        if (!notionDB_id || !name || !knowledge_base_id) {
            console.error(`❌ 不足している情報があります。この行の処理をスキップします: ${JSON.stringify(notionDB)}`);
            continue; // 次のnotionDBへ
        }

        try {
            console.log(`\n--- ${name} (${notionDB_id}) の処理を開始します ---`);
            
            const { csvString: notionCsv, safeName } = await getNotionPostsAndConvertToCsv(notionDB_id, name);
            console.log(`NotionDBデータ取得とCSV文字列生成完了: ${safeName}`);
            
            const difyCsvArray = await convertToDifyReadyCsv(notionCsv);
            console.log(`Dify用CSV文字列への変換完了: ${safeName} (${difyCsvArray.length}個のファイルに分割)`);

            for (let i = 0; i < difyCsvArray.length; i++) {
                const difyCsvChunk = difyCsvArray[i];
                const uploadFileName = `${safeName}_dify_doc_part${i + 1}.csv`; 
                
                await uploadCsvToDify(difyCsvChunk, knowledge_base_id, uploadFileName);
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
    const notionDBsCsvFilePath = process.argv[2];

    async function main() {
        let notionDBsToProcess = [];

        if (notionDBsCsvFilePath) {
            console.log(`CSVファイル '${notionDBsCsvFilePath}' からnotionDB情報を読み込みます。`);
            if (!fs.existsSync(notionDBsCsvFilePath)) {
                console.error(`エラー: 指定されたCSVファイルが見つかりません - ${notionDBsCsvFilePath}。`);
                process.exit(1);
            }

            try {
                const csvFileContent = fs.readFileSync(notionDBsCsvFilePath, 'utf8');
                await new Promise((resolve, reject) => {
                    Readable.from(csvFileContent)
                        .pipe(csv())
                        .on('data', (row) => {
                            // ★ 修正点: CSVのヘッダー名 'notionDB_id' を想定
                            notionDBsToProcess.push({
                                notionDB_id: row.notionDB_id,
                                name: row.name,
                                knowledge_base_id: row.knowledge_base_id,
                                document_id: row.document_id || null
                            });
                        })
                        .on('end', () => {
                            console.log(`CSVファイルから ${notionDBsToProcess.length} 件のnotionDB情報を読み込みました。`);
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
            console.log('CSVファイルパスが指定されていないため、NotionからnotionDB情報を取得します。');
            try {
                notionDBsToProcess = await getNotionDBTargetFromNotion();
                console.log(`Notionから ${notionDBsToProcess.length} 件のnotionDB情報を取得しました。`);
            } catch (err) {
                console.error(`❌ NotionからのnotionDB情報取得に失敗しました: ${err.message}`);
                process.exit(1);
            }
        }

        await processNotionDBs(notionDBsToProcess);
    }

    main().catch(console.error);
}
