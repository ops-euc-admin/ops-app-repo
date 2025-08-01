const axios = require('axios');
const FormData = require('form-data');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

/**
 * CSV文字列をDifyのナレッジベースにファイルとしてアップロードします。
 * この関数は他のモジュールから呼び出されることを想定しています。
 * @param {string} csvString - アップロードするCSVデータ（文字列）
 * @param {string} knowledgeBaseId - アップロード先のDifyナレッジベースID (dataset_id)
 * @param {string} fileName - Dify上で表示されるファイル名（拡張子含む）
 */
async function uploadCsvToDify(csvString, knowledgeBaseId, fileName) {
    const DIFY_API_KEY = process.env.DIFY_API_KEY;
    const DIFY_BASE_URL = process.env.DIFY_API_URL || 'https://dify.app.uzabase.com'; 

    if (!DIFY_API_KEY || !knowledgeBaseId) {
        throw new Error('DIFY_API_KEY and knowledgeBaseId are required.');
    }
    if (!fileName) {
        throw new Error('File name is required for Dify upload. It should include the extension (e.g., .csv).');
    }

    // 新規ファイルアップロード用のAPIエンドポイントを構築
    const apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/document/create-by-file`; 

    console.log(`Uploading file '${fileName}' to Dify knowledge base: ${knowledgeBaseId} via ${apiUrl}...`);

    const form = new FormData();
    
    // curlサンプルに合わせて 'data' フィールドをJSON文字列として追加
    // nameは'data'フィールドのJSON内ではなく、FormDataのトップレベルに追加する
    const dataPayload = {
        // name: fileName, // 'name'は'data'フィールド内ではなく、トップレベルのFormDataに追加
        indexing_technique: "high_quality",
        process_rule: {
            rules: {
                pre_processing_rules: [
                    { id: "remove_extra_spaces", enabled: true },
                    { id: "remove_urls_emails", enabled: true }
                ],
                segmentation: {
                    separator: "###", // スクリーンショットのチャンク識別子に合わせて調整
                    max_tokens: 500   // スクリーンショットの最大チャンク長に合わせて調整
                }
            },
            mode: "custom" // process_rule.rules を指定する場合は mode: "custom"
        }
    };
    form.append('data', JSON.stringify(dataPayload), { contentType: 'text/plain' });

    // ドキュメント名 (name) をFormDataのトップレベルに追加
    form.append('name', fileName);

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
            console.log(`✅ Upload successful for '${fileName}'. Document ID: ${response.data.document.id}`);
            return response.data;
        } else {
            console.error(`❌ Upload failed for '${fileName}'. Response:`, response.data);
            throw new Error('Dify API upload failed: Unexpected response structure or status.');
        }

    } catch (error) {
        console.error(`❌ An error occurred during Dify upload for '${fileName}':`, error.response?.data || error.message);
        throw error;
    }
}

// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node dify-uploader.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    const inputFilePath = process.argv[2];
    const knowledgeBaseId = process.argv[3];
    let fileName = process.argv[4]; // Difyにアップロードする際のドキュメント名（オプション）

    if (!inputFilePath || !knowledgeBaseId) {
        console.log('Usage: node dify-uploader.js <input_csv_file.csv> <knowledge_base_id> [dify_document_name]');
        console.log('Example: node dify-uploader.js dify_ready_part1.csv kb_abcdefgh "My Slack Data Doc.csv"');
        console.log('         (dify_document_nameが省略された場合、CSVファイル名が使用されます)');
        process.exit(1);
    }

    if (!fs.existsSync(inputFilePath)) {
        console.error(`Error: File not found - ${inputFilePath}.`);
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

            // Difyにアップロード
            await uploadCsvToDify(csvString, knowledgeBaseId, fileName);
            console.log(`✅ Successfully uploaded ${inputFilePath} to Dify.`);
        } catch (err) {
            console.error(`❌ Failed to upload ${inputFilePath}: ${err.message}`);
            process.exit(1);
        }
    }

    main().catch(console.error);
}

// 他のファイルから require で呼び出せるように関数を公開
module.exports = {
    uploadCsvToDify
};
