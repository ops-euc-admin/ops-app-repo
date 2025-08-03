/**
 * 0_get-knowledge-targets.js
 * * 管理用Notionデータベースから、Difyに登録するナレッジソース（notionDBアイテム または notionPage）のリストを取得します。
 * * 実行方法:
 * node 0_get-knowledge-targets.js
 */
const { Client } = require("@notionhq/client");
const { stringify } = require("csv-stringify");
const fs = require("fs");
require("dotenv").config();

// --- 環境変数チェック ---
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    const message = '環境変数 NOTION_API_KEY または NOTION_DATABASE_ID が設定されていません。';
    console.error(`❌ ${message}`);
    if (require.main !== module) throw new Error(message);
    process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

/**
 * 管理用Notionデータベースから処理対象のナレッジリストを取得します。
 * 「ナレッジ種別」が「notionDBアイテム」または「notionPage」のデータを取得します。
 * @returns {Promise<Array<Object>>} 処理対象情報の配列
 */
async function getKnowledgeTargetsFromNotion() {
    console.log("📘 Notionから処理対象のナレッジリストを取得開始...");

    const targets = [];
    try {
        // 'notionDBアイテム' または 'notionPage' のいずれかであるものをフィルタリング
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            filter: {
                or: [
                    { property: 'ナレッジ種別', select: { equals: 'notionDBアイテム' } },
                    { property: 'ナレッジ種別', select: { equals: 'notionPage' } }
                ]
            }
        });

        for (const page of response.results) {
            const props = page.properties;
            const name = props["Difyナレッジ登録名"]?.title?.[0]?.plain_text || "";
            const knowledgeBaseId = props["dify_db_key"]?.rich_text?.[0]?.plain_text || "";
            const knowledgeType = props["ナレッジ種別"]?.select?.name;
            
            // どちらのタイプでも、IDは 'NotionPageID' プロパティから取得
            const sourceId = props["NotionPageID"]?.rich_text?.[0]?.plain_text || "";

            if (name && knowledgeBaseId && knowledgeType && sourceId) {
                targets.push({
                    name: name,
                    knowledge_base_id: knowledgeBaseId,
                    type: knowledgeType, // 'notionDBアイテム' or 'notionPage'
                    source_id: sourceId, // ページのID
                });
            } else {
                console.warn(`⚠️ 必須情報が不足しているため、この行をスキップします: ${name || '名称不明'}`);
            }
        }
        console.log(`✅ Notionから ${targets.length} 件の処理対象情報を取得しました。`);
        return targets;

    } catch (error) {
        console.error('❌ Notionからのデータ取得中にエラーが発生しました:', error.message);
        throw error;
    }
}

// --- コマンドラインからの独立実行用 ---
if (require.main === module) {
    const outputFilePath = "knowledge_targets.csv";

    (async () => {
        try {
            const targets = await getKnowledgeTargetsFromNotion();
            console.log('\n--- 取得したナレッジ情報 ---');
            console.table(targets);

            const columns = ["name", "knowledge_base_id", "type", "source_id"];
            const dataToCsv = targets.map(t => [t.name, t.knowledge_base_id, t.type, t.source_id]);

            stringify(dataToCsv, { header: true, columns: columns }, (err, output) => {
                if (err) {
                    console.error("❌ CSV生成中にエラーが発生しました:", err);
                    return;
                }
                fs.writeFile(outputFilePath, output, (err) => {
                    if (err) {
                        console.error("❌ ファイル書き込み中にエラーが発生しました:", err);
                        return;
                    }
                    console.log(`\n✅ データが正常に ${outputFilePath} に出力されました。`);
                });
            });
        } catch (err) {
            console.error(`❌ 処理全体でエラーが発生しました: ${err.message}`);
            process.exit(1);
        }
    })();
}

module.exports = {
    getKnowledgeTargetsFromNotion
};
