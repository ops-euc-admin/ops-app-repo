const { Client } = require("@notionhq/client");
const { stringify } = require("csv-stringify");
const fs = require("fs");
require("dotenv").config();

// 環境変数からNotion APIキーとデータベースIDを取得
const NOTION_API_KEY = process.env.NOTION_API_KEY; 
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion APIクライアントの初期化
if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    console.error('環境変数 NOTION_API_KEY または NOTION_DATABASE_ID が設定されていません。');
    // main-processor.jsから呼ばれる場合にエラーをスロー
    if (require.main !== module) {
        throw new Error('Notion API credentials (NOTION_API_KEY or NOTION_DATABASE_ID) are not set in environment variables.');
    }
}

const notion = new Client({ auth: NOTION_API_KEY });

/**
 * NotionデータベースからSlackチャンネルのターゲット情報を取得します。
 * 「ナレッジ種別」が「slack」のデータのみをフィルタリングします。
 * @returns {Promise<Array<Object>>} チャンネル情報の配列
 */
async function getSlackChannelTargetFromNotion() {
    console.log('NotionからSlackチャンネルターゲット情報を取得中...');
    
    const channels = [];
    try {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            // 「ナレッジ種別」プロパティが「slack」であるものをフィルタリング
            filter: {
                property: 'ナレッジ種別',
                select: {
                    equals: 'slack'
                }
            }
        });

        for (const page of response.results) {
            const properties = page.properties;
            // Notionのプロパティ名と、channelsToProcessが期待するキー名をマッピング
            // Notionデータベースの実際のプロパティ名に合わせて、ここを調整してください
            const channelId = properties["SlackチャネルID"]?.rich_text?.[0]?.plain_text || "";
            const name = properties["Difyナレッジ登録名"]?.title?.[0]?.plain_text || ""; // 'name' にマッピング
            const knowledgeBaseId = properties["dify_db_key"]?.rich_text?.[0]?.plain_text || ""; // 'knowledge_base_id' にマッピング
            const documentId = properties["document_id"]?.rich_text?.[0]?.plain_text || null; // オプション

            // いずれか一つの項目が記載されていない場合は出力しない
            if (channelId && name && knowledgeBaseId) {
                channels.push({
                    channel_id: channelId,
                    name: name,
                    knowledge_base_id: knowledgeBaseId,
                    document_id: documentId
                });
            } else {
                console.warn(`Notionの行で必須情報が不足しています。スキップします: ${JSON.stringify(properties)}`);
            }
        }
        console.log(`Notionから ${channels.length} 件のチャンネル情報を取得しました。`);
        return channels;

    } catch (error) {
        console.error('❌ Notionからのデータ取得中にエラーが発生しました:', error.message);
        throw error; // エラーを上位にスロー
    }
}

// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node 0_notion-to-slack-list.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    const outputFilePath = "slack_list.csv"; // CSV出力先のファイル名

    // コマンドラインから直接実行された場合のテストロジック
    // Notionから取得したチャンネル情報をCSVファイルに出力
    getSlackChannelTargetFromNotion()
        .then(channels => {
            console.log('\n--- Notionから取得したチャンネル情報 ---');
            channels.forEach(channel => console.log(channel));

            // CSVに含めるヘッダーを定義 (main-processor.jsが期待する形式に合わせる)
            const columns = [
                "channel_id",
                "name",
                "knowledge_base_id",
                "document_id",
            ];

            const dataToCsv = channels.map(c => [
                c.channel_id,
                c.name,
                c.knowledge_base_id,
                c.document_id || '' // nullの場合は空文字列にする
            ]);

            // CSV文字列を生成してファイルに書き出し
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

// 他のファイルから require で呼び出せるように関数を公開
module.exports = {
    getSlackChannelTargetFromNotion
};
