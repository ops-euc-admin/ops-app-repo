const axios = require('axios');
const FormData = require('form-data');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

/**
 * CSV文字列をDifyのナレッジベースにファイルとしてアップロード（新規作成または更新）します。
 * この関数は他のモジュールから呼び出されることを想定しています。
 * @param {string} csvString - アップロードするCSVデータ（文字列）
 * @param {string} knowledgeBaseId - アップロード先のDifyナレッジベースID (dataset_id)
 * @param {string} fileName - Dify上で表示されるファイル名（拡張子含む）
 * @param {string} [documentId=null] - 更新対象のドキュメントID。指定しない場合は新規作成。
 */
async function uploadCsvToDify(csvString, knowledgeBaseId, fileName, documentId = null) {
    const DIFY_API_KEY = process.env.DIFY_API_KEY;
    const DIFY_BASE_URL = process.env.DIFY_API_URL || 'https://dify.app.uzabase.com'; 

    if (!DIFY_API_KEY || !knowledgeBaseId) {
        throw new Error('DIFY_API_KEY and knowledgeBaseId are required.');
    }
    if (!fileName) {
        throw new Error('File name is required for Dify upload. It should include the extension (e.g., .csv).');
    }

    let apiUrl;
    let actionType;

    if (documentId) {
        // 既存ドキュメントを更新する場合
        apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/documents/${documentId}/update-by-file`;
        actionType = '更新';
    } else {
        // 新規ドキュメントを作成する場合
        apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/document/create-by-file`;
        actionType = '新規作成';
    }

    console.log(`${actionType}ドキュメント '${fileName}' (ID: ${documentId || '新規'}) をDifyナレッジベース: ${knowledgeBaseId} へ ${apiUrl} 経由でアップロード中...`);

    const form = new FormData();
    
    // curlサンプルとチャンク設定のスクリーンショットに合わせて 'data' フィールドをJSON文字列として追加
    const dataPayload = {
        name: fileName, // ドキュメント名
        indexing_technique: "high_quality",
        process_rule: {
            rules: {
                pre_processing_rules: [
                    { id: "remove_extra_spaces", enabled: true },
                    { id: "remove_urls_emails", enabled: true }
                ],
                segmentation: {
                    separator: "\n\n", // スクリーンショットのチャンク識別子
                    max_tokens: 1024   // スクリーンショットの最大チャンク長
                }
            },
            mode: "custom" // process_rule.rules を指定する場合は mode: "custom"
        }
    };
    form.append('data', JSON.stringify(dataPayload), { contentType: 'text/plain' });

    // ファイル (file) をFormDataに追加
    form.append('file', Buffer.from(csvString, 'utf8'), {
        filename: fileName, // Difyにアップロードされるファイル名
        contentType: 'text/csv',
    });
    
    try {
        const response = await axios.post(
            apiUrl,
            form, // FormDataを送信
            {
                headers: {
                    ...form.getHeaders(), // FormDataのヘッダーを忘れずに含める
                    'Authorization': `Bearer ${DIFY_API_KEY}`,
                },
                maxContentLength: Infinity, // 大容量ファイルのアップロードに対応
                maxBodyLength: Infinity,
            }
        );

        // レスポンス構造はcreate-by-textと同様の document オブジェクトを期待
        if (response.data && response.data.document && response.data.document.id) { 
            console.log(`✅ アップロード成功: '${fileName}'. ドキュメントID: ${response.data.document.id}`);
            return response.data;
        } else {
            console.error(`❌ アップロード失敗: '${fileName}'. レスポンス:`, response.data);
            throw new Error('Dify APIアップロード失敗: 予期せぬレスポンス構造またはステータス。');
        }

    } catch (error) {
        console.error(`❌ Difyアップロード中にエラーが発生しました: '${fileName}':`, error.response?.data || error.message);
        throw error;
    }
}

// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node dify-uploader.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    const inputFilePath = process.argv[2];
    const knowledgeBaseId = process.argv[3];
    let fileName = process.argv[4]; // Difyにアップロードする際のドキュメント名（オプション）
    const documentId = process.argv[5]; // 更新対象のドキュメントID（オプション）

    if (!inputFilePath || !knowledgeBaseId) {
        console.log('使用法 (新規作成): node dify-uploader.js <input_csv_file.csv> <knowledge_base_id> [dify_document_name]');
        console.log('使用法 (更新):   node dify-uploader.js <input_csv_file.csv> <knowledge_base_id> <dify_document_name> <document_id>');
        console.log('例 (新規作成): node dify-uploader.js dify_ready_part1.csv kb_abcdefgh "My Slack Data Doc.csv"');
        console.log('例 (更新):   node dify-uploader.js dify_ready_part1.csv kb_abcdefgh "My Updated Doc.csv" doc_1234567890');
        console.log('         (dify_document_nameが省略された場合、CSVファイル名が使用されます)');
        process.exit(1);
    }

    if (!fs.existsSync(inputFilePath)) {
        console.error(`エラー: ファイルが見つかりません - ${inputFilePath}。`);
        process.exit(1);
    }

    async function main() {
        try {
            // ファイルからCSVデータを読み込む
            const csvString = fs.readFileSync(inputFilePath, 'utf8');

            // fileNameが指定されていない場合、inputFilePathから生成
            if (!fileName) {
                fileName = path.basename(inputFilePath); 
                console.log(`ドキュメント名が指定されていません。ファイル名 '${fileName}' を使用します。`);
            }

            // Difyにアップロードまたは更新
            await uploadCsvToDify(csvString, knowledgeBaseId, fileName, documentId);
            console.log(`✅ ${inputFilePath} のDifyへのアップロード/更新が成功しました。`);
        } catch (err) {
            console.error(`❌ ${inputFilePath} のアップロード/更新に失敗しました: ${err.message}`);
            process.exit(1);
        }
    }

    main().catch(console.error);
}

// 他のファイルから require で呼び出せるように関数を公開
module.exports = {
    uploadCsvToDify
};
