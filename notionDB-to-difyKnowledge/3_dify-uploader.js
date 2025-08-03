const axios = require('axios');
const FormData = require('form-data');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

/**
 * Dify APIの基本URL
 * .envにDIFY_API_URLが設定されていなければ、提供されたURLをデフォルトとする
 */
const DIFY_BASE_URL = process.env.DIFY_API_URL; 
const DIFY_API_KEY = process.env.DIFY_API_KEY;

if (!DIFY_API_KEY) {
    console.error('環境変数 DIFY_API_KEY が設定されていません。');
    process.exit(1);
}

/**
 * 指定されたナレッジベース内のドキュメントを、完全なドキュメント名で検索します。
 * @param {string} knowledgeBaseId - ナレッジベースID
 * @param {string} exactFileName - 検索するドキュメントの完全なファイル名（例: "slack_general_dify_doc.csv"）
 * @returns {Promise<Array<Object>>} 見つかったドキュメントの配列
 */
async function findDocumentsInDify(knowledgeBaseId, exactFileName) {
    const apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/documents`;
    console.log(`Difyドキュメントを検索中: '${exactFileName}' in ${knowledgeBaseId}`);

    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json',
            },
            // Dify APIが名前でのフィルタリングをサポートしている場合、ここにクエリパラメータを追加
            // 例: params: { name: exactFileName }
        });

        if (response.data && Array.isArray(response.data.data)) {
            // APIが名前フィルタリングをサポートしない場合、クライアント側で厳密にフィルタリング
            const foundDocuments = response.data.data.filter(doc => 
                doc.name === exactFileName // 完全一致で検索
            );
            console.log(`Difyで ${foundDocuments.length} 件の既存ドキュメントが見つかりました。`);
            return foundDocuments;
        } else {
            console.warn('Difyドキュメント検索のレスポンスが予期せぬ構造です:', response.data);
            return [];
        }
    } catch (error) {
        console.error(`❌ Difyドキュメント検索中にエラーが発生しました:`, error.response?.data || error.message);
        return []; // エラー時も空の配列を返す
    }
}

/**
 * 指定されたドキュメントをDifyから削除します。
 * @param {string} knowledgeBaseId - ナレッジベースID
 * @param {string} documentId - 削除するドキュメントID
 * @returns {Promise<boolean>} 削除が成功したか
 */
async function deleteDocumentFromDify(knowledgeBaseId, documentId) {
    const apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/documents/${documentId}`;
    console.log(`Difyドキュメントを削除中: ID ${documentId} from ${knowledgeBaseId}`);

    try {
        const response = await axios.delete(apiUrl, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
            },
        });

        // Difyの削除APIのレスポンスに合わせて成功判定を調整
        if (response.status === 200 || response.status === 204) { // 200 OK or 204 No Content
            console.log(`✅ ドキュメントID ${documentId} の削除が成功しました。`);
            return true;
        } else {
            console.error(`❌ ドキュメントID ${documentId} の削除に失敗しました。レスポンス:`, response.data);
            return false;
        }
    } catch (error) {
        console.error(`❌ ドキュメントID ${documentId} の削除中にエラーが発生しました:`, error.response?.data || error.message);
        return false;
    }
}

/**
 * CSV文字列をDifyのナレッジベースにファイルとしてアップロード（新規作成）します。
 * @param {string} csvString - アップロードするCSVデータ（文字列）
 * @param {string} knowledgeBaseId - アップロード先のDifyナレッジベースID (dataset_id)
 * @param {string} fileName - Dify上で表示されるファイル名（拡張子含む）
 * @returns {Promise<Object>} Dify APIからのレスポンスデータ
 */
async function createDocumentInDify(csvString, knowledgeBaseId, fileName) {
    const apiUrl = `${DIFY_BASE_URL}/v1/datasets/${knowledgeBaseId}/document/create-by-file`; 

    console.log(`新規ドキュメント '${fileName}' をDifyナレッジベース: ${knowledgeBaseId} へ ${apiUrl} 経由でアップロード中...`);

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

/**
 * CSV文字列をDifyのナレッジベースにアップロードまたは更新します。
 * 既存ドキュメントがあれば削除し、新規作成します。
 * @param {string} csvString - アップロードするCSVデータ（文字列）
 * @param {string} knowledgeBaseId - アップロード先のDifyナレッジベースID (dataset_id)
 * @param {string} fileName - Dify上で表示されるファイル名（拡張子含む）。既存ドキュメントの検索にも使用。
 */
async function uploadOrUpdateCsvToDify(csvString, knowledgeBaseId, fileName) {
    // 既存ドキュメントを検索
    // ここで fileName をそのまま渡すことで、完全一致で検索します。
    const existingDocs = await findDocumentsInDify(knowledgeBaseId, fileName); 

    // 見つかった既存ドキュメントをすべて削除
    for (const doc of existingDocs) {
        await deleteDocumentFromDify(knowledgeBaseId, doc.id);
    }

    // 新規ドキュメントとしてアップロード
    return createDocumentInDify(csvString, knowledgeBaseId, fileName);
}


// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node dify-uploader.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    const inputFilePath = process.argv[2];
    const knowledgeBaseId = process.argv[3];
    let fileName = process.argv[4]; // Difyにアップロードする際のドキュメント名（オプション）

    if (!inputFilePath || !knowledgeBaseId) {
        console.log('使用法: node dify-uploader.js <input_csv_file.csv> <knowledge_base_id> [dify_document_name]');
        console.log('例: node dify-uploader.js dify_ready_part1.csv kb_abcdefgh "My Slack Data Doc.csv"');
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

            // Difyにアップロードまたは更新 (削除してから新規作成)
            await uploadOrUpdateCsvToDify(csvString, knowledgeBaseId, fileName);
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
    uploadCsvToDify: uploadOrUpdateCsvToDify // 関数名を変更
};
