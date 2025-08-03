const { Client } = require("@notionhq/client");
const { stringify } = require("csv-stringify");
const fs = require("fs");
require("dotenv").config();

const NOTION_API_KEY = process.env.NOTION_API_KEY; 
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    console.error('環境変数 NOTION_API_KEY または NOTION_DATABASE_ID が設定されていません。');
    if (require.main !== module) {
        throw new Error('Notion API credentials (NOTION_API_KEY or NOTION_DATABASE_ID) are not set in environment variables.');
    }
}

const notion = new Client({ auth: NOTION_API_KEY });

/**
 * Notionデータベースから処理対象のNotionDB情報を取得します。
 * 「ナレッジ種別」が「notionDB」のデータのみをフィルタリングします。
 * @returns {Promise<Array<Object>>} データベース情報の配列
 */
async function getNotionDBTargetFromNotion() {
    console.log('NotionからNotionDBターゲット情報を取得中...');
    
    const notionDBs = [];
    try {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            filter: {
                property: 'ナレッジ種別',
                select: {
                    equals: 'notionDB'
                }
            }
        });

        for (const page of response.results) {
            const properties = page.properties;
            const NotionDBID = properties["NotionDBID"]?.rich_text?.[0]?.plain_text || "";
            const name = properties["Difyナレッジ登録名"]?.title?.[0]?.plain_text || "";
            const knowledgeBaseId = properties["dify_db_key"]?.rich_text?.[0]?.plain_text || "";
            const documentId = properties["document_id"]?.rich_text?.[0]?.plain_text || null;

            if (NotionDBID && name && knowledgeBaseId) {
                // ★ 修正点: キー名を 'notionDB_id' に統一
                notionDBs.push({
                    notionDB_id: NotionDBID,
                    name: name,
                    knowledge_base_id: knowledgeBaseId,
                    document_id: documentId
                });
            } else {
                console.warn(`Notionの行で必須情報が不足しています。スキップします: ${JSON.stringify(properties)}`);
            }
        }
        console.log(`Notionから ${notionDBs.length} 件のNotionDB情報を取得しました。`);
        return notionDBs;

    } catch (error) {
        console.error('❌ Notionからのデータ取得中にエラーが発生しました:', error.message);
        throw error;
    }
}

// --- コマンドラインからの独立実行用の部分 ---
if (require.main === module) {
    const outputFilePath = "notiondb_list.csv"; 

    getNotionDBTargetFromNotion()
        .then(notionDBs => {
            console.log('\n--- Notionから取得したNotionDB情報 ---');
            notionDBs.forEach(notionDB => console.log(notionDB));

            // ★ 修正点: CSVヘッダー名を 'notionDB_id' に統一
            const columns = [
                "notionDB_id",
                "name",
                "knowledge_base_id",
                "document_id",
            ];

            const dataToCsv = notionDBs.map(db => [
                db.notionDB_id,
                db.name,
                db.knowledge_base_id,
                db.document_id || ''
            ]);

            stringify(
                dataToCsv,
                { header: true, columns: columns },
                (err, output) => {
                    if (err) {
                        console.error("CSV生成中にエラーが発生しました:", err);
                        return;
                    }
                    fs.writeFile(outputFilePath, output, (err) => {
                        if (err) {
                            console.error("ファイル書き込み中にエラーが発生しました:", err);
                            return;
                        }
                        console.log(`✅ データが正常に ${outputFilePath} に出力されました。`);
                    });
                }
            );
        })
        .catch(err => {
            console.error(`❌ Notionからの情報取得に失敗しました: ${err.message}`);
            process.exit(1);
        });
}

module.exports = {
    getNotionDBTargetFromNotion
};
