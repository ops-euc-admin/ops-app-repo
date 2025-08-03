/**
 * 3_upload-to-dify.js
 * * 変換済みのCSV文字列をDifyのナレッジベースにアップロードします。
 * * [修正] ご提供いただいた正常動作コードに基づき、APIのURLとペイロード形式を完全に修正しました。
 * * 実行方法:
 * node 3_upload-to-dify.js <入力CSVファイルパス> <knowledge_base_id> [dify_document_name]
 */
const axios = require('axios');
const FormData = require('form-data');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

// --- 環境変数チェック ---
const DIFY_BASE_URL = process.env.DIFY_API_URL;
const DIFY_API_KEY = process.env.DIFY_API_KEY;

if (!DIFY_API_KEY || !DIFY_BASE_URL) {
    const message = '環境変数 DIFY_API_KEY または DIFY_API_URL が設定されていません。';
    console.error(`❌ ${message}`);
    if (require.main !== module) throw new Error(message);
    process.exit(1);
}

// --- Dify API ラッパー関数 ---

async function findDocumentsInDify(knowledgeBaseId, exactFileName) {
    // [修正] APIパスに /v1 を追加
    const apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/documents`;
    console.log(`  - Difyで既存ドキュメントを検索中: '${exactFileName}'`);
    try {
        const response = await axios.get(apiUrl, {
            headers: { 'Authorization': `Bearer ${DIFY_API_KEY}` }
        });
        const found = response.data?.data?.filter(doc => doc.name === exactFileName) || [];
        console.log(`    -> ${found.length} 件の既存ドキュメントを発見。`);
        return found;
    } catch (error) {
        console.error(`❌ Difyドキュメント検索エラー:`, error.response?.data || error.message);
        return [];
    }
}

async function deleteDocumentFromDify(knowledgeBaseId, documentId, documentName) {
    // [修正] APIパスに /v1 を追加
    const apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/documents/${documentId}`;
    console.log(`  - Difyから既存ドキュメントを削除中: '${documentName}' (ID: ${documentId})`);
    try {
        await axios.delete(apiUrl, {
            headers: { 'Authorization': `Bearer ${DIFY_API_KEY}` }
        });
        console.log(`    -> 削除成功。`);
        return true;
    } catch (error) {
        console.error(`❌ ドキュメント削除エラー:`, error.response?.data || error.message);
        return false;
    }
}

async function createDocumentInDify(csvString, knowledgeBaseId, fileName) {
    // [修正] APIパスに /v1 を追加
    const apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/document/create-by-file`;
    console.log(`  - 新規ドキュメントをアップロード中: '${fileName}'`);

    const form = new FormData();
    
    // [修正] 正常動作コードに合わせて、'data'フィールドにJSON文字列としてペイロードを格納
    const dataPayload = {
        name: fileName,
        indexing_technique: "high_quality",
        process_rule: {
            mode: "custom",
            rules: {
                pre_processing_rules: [
                    { id: "remove_extra_spaces", enabled: true },
                    { id: "remove_urls_emails", enabled: true }
                ],
                segmentation: { separator: "\n\n", max_tokens: 1024 }
            }
        }
    };
    form.append('data', JSON.stringify(dataPayload), { contentType: 'text/plain' });
    
    form.append('file', Buffer.from(csvString, 'utf8'), { filename: fileName, contentType: 'text/csv' });
    
    try {
        const response = await axios.post(apiUrl, form, {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${DIFY_API_KEY}` },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });
        if (response.data?.document?.id) {
            console.log(`    -> ✅ アップロード成功。ドキュメントID: ${response.data.document.id}`);
            return response.data;
        }
        throw new Error(`予期せぬレスポンス構造: ${JSON.stringify(response.data)}`);
    } catch (error) {
        console.error(`❌ Difyアップロードエラー: ${error.message}`);
        console.error(`[詳細] 失敗したURL: ${apiUrl}`);
        if (error.response) {
            console.error(`[詳細] Status: ${error.response.status}`);
        }
        throw error;
    }
}

// --- メイン処理関数 ---

/**
 * CSV文字列をDifyのナレッジベースにアップロードまたは更新します。
 * @param {string} csvString - アップロードするCSVデータ（文字列）
 * @param {string} knowledgeBaseId - DifyナレッジベースID
 * @param {string} fileName - Dify上でのファイル名
 */
async function uploadCsvToDify(csvString, knowledgeBaseId, fileName) {
    console.log(`\n🚀 Difyへのアップロード/更新処理を開始: '${fileName}'`);
    const existingDocs = await findDocumentsInDify(knowledgeBaseId, fileName);
    for (const doc of existingDocs) {
        await deleteDocumentFromDify(knowledgeBaseId, doc.id, doc.name);
    }
    return createDocumentInDify(csvString, knowledgeBaseId, fileName);
}

// --- コマンドラインからの独立実行用 ---
if (require.main === module) {
    const main = async () => {
        const inputFilePath = process.argv[2];
        const knowledgeBaseId = process.argv[3];
        let fileName = process.argv[4] || path.basename(inputFilePath);

        if (!inputFilePath || !knowledgeBaseId || !fs.existsSync(inputFilePath)) {
            console.error('使用法: node 3_upload-to-dify.js <input_csv_file> <knowledge_base_id> [dify_document_name]');
            process.exit(1);
        }
        
        try {
            const csvString = fs.readFileSync(inputFilePath, 'utf8');
            await uploadCsvToDify(csvString, knowledgeBaseId, fileName);
            console.log(`\n🎉 処理が正常に完了しました。`);
        } catch (err) {
            // エラーメッセージは呼び出し元の関数で表示されるため、ここではシンプルに終了
            process.exit(1);
        }
    };
    main().catch(console.error);
}

module.exports = {
    uploadCsvToDify
};
