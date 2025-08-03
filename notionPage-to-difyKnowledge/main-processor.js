/**
 * main-processor.js
 * * NotionからDifyへのナレッジ連携プロセス全体を統括するメインスクリプト。
 * 1. 処理対象のリストをNotionまたはCSVファイルから取得
 * 2. 各対象についてNotionからコンテンツを取得しCSV文字列化
 * 3. Dify用のフォーマットに変換（要約生成、ファイル分割）
 * 4. Difyナレッジベースにアップロード（既存ファイルは上書き）
 * * 実行方法:
 * 1. Notionから直接リストを取得: node main-processor.js
 * 2. CSVファイルからリストを取得: node main-processor.js <csv_file_path>
 */
const { getKnowledgeTargetsFromNotion } = require('./0_get-knowledge-targets.js');
const { fetchNotionContent } = require('./1_fetch-notion-content.js');
const { convertToDifyReadyCsv } = require('./2_convert-to-dify-format.js');
const { uploadCsvToDify } = require('./3_upload-to-dify.js');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

/**
 * 複数のナレッジソースをDifyナレッジベースに連携するプロセスを実行します。
 * @param {Array<Object>} targets - 処理するナレッジソース情報の配列
 */
async function processKnowledgeTargets(targets) {
    if (!targets || targets.length === 0) {
        console.warn('処理対象のナレッジソースが指定されていません。');
        return;
    }

    for (const target of targets) {
        const { name, knowledge_base_id, type, source_id } = target;

        if (!name || !knowledge_base_id || !type || !source_id) {
            console.error(`❌ 必須情報が不足しています。この行の処理をスキップします: ${JSON.stringify(target)}`);
            continue;
        }

        try {
            console.log(`\n\n--- [${name}] の処理を開始します (Type: ${type}, ID: ${source_id}) ---`);
            
            // 1. Notionからコンテンツを取得し、CSV文字列を生成
            const { csvString, safeName } = await fetchNotionContent(target);
            console.log(`[${name}] ✅ Notionコンテンツ取得とCSV文字列生成完了`);
            
            // 2. Dify用フォーマットに変換（必要なら分割）
            const difyCsvChunks = await convertToDifyReadyCsv(csvString);
            console.log(`[${name}] ✅ Dify用CSVへの変換完了 (${difyCsvChunks.length}個のファイルに分割)`);

            // 3. 分割された各チャンクをDifyにアップロード
            for (let i = 0; i < difyCsvChunks.length; i++) {
                const difyCsvChunk = difyCsvChunks[i];
                const uploadFileName = `${safeName}_dify_doc_part${i + 1}.csv`;
                
                await uploadCsvToDify(difyCsvChunk, knowledge_base_id, uploadFileName);
                console.log(`[${name}] ✅ Difyへのアップロード/更新完了: ${uploadFileName}`);
            }

            console.log(`--- [${name}] の処理が正常に完了しました ---`);
            
        } catch (error) {
            console.error(`\n❌ [${name}] の処理中にエラーが発生しました: ${error.message}`);
        }
    }
}

// --- スクリプト実行部分 ---
if (require.main === module) {
    const targetsCsvFilePath = process.argv[2];

    const main = async () => {
        let targetsToProcess = [];

        if (targetsCsvFilePath) {
            console.log(`📂 CSVファイル '${targetsCsvFilePath}' からナレッジソース情報を読み込みます。`);
            if (!fs.existsSync(targetsCsvFilePath)) {
                console.error(`エラー: 指定されたCSVファイルが見つかりません - ${targetsCsvFilePath}`);
                process.exit(1);
            }
            try {
                const csvFileContent = fs.readFileSync(targetsCsvFilePath, 'utf8');
                // CSVのヘッダーは 'name', 'knowledge_base_id', 'type', 'source_id' を想定
                targetsToProcess = parse(csvFileContent, { columns: true, skip_empty_lines: true });
                console.log(`✅ CSVファイルから ${targetsToProcess.length} 件の情報を読み込みました。`);
            } catch (err) {
                console.error(`❌ CSVファイルの処理中にエラーが発生しました: ${err.message}`);
                process.exit(1);
            }
        } else {
            console.log('☁️ Notionから直接ナレッジソース情報を取得します。');
            try {
                targetsToProcess = await getKnowledgeTargetsFromNotion();
            } catch (err) {
                console.error(`❌ Notionからの情報取得に失敗しました: ${err.message}`);
                process.exit(1);
            }
        }

        await processKnowledgeTargets(targetsToProcess);
        console.log("\n\n🎉 全ての処理が完了しました。");
    };

    main().catch(console.error);
}
