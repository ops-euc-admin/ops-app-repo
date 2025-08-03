/**
 * 1_notionDB-get_recursive.js
 * * 指定されたNotionデータベースからすべての投稿を動的に取得し、CSV形式の文字列を返します。
 * * [変更点] 各ページ内に含まれるサブページや子データベースのコンテンツもすべて取得するよう、再帰処理を追加しました。
 * * 実行方法:
 * node 1_notionDB-get_recursive.js <database_id> [output_name]
 */
const { Client } = require("@notionhq/client");
const { stringify } = require("csv-stringify/sync");
const fs = require("fs");
require("dotenv").config();

// 環境変数からNotion APIキーを取得
const NOTION_API_KEY = process.env.NOTION_API_KEY;

// Notion APIクライアントの初期化
if (!NOTION_API_KEY) {
    console.error('環境変数 NOTION_API_KEY が設定されていません。');
    if (require.main !== module) {
        throw new Error('Notion API key (NOTION_API_KEY) is not set in environment variables.');
    }
    process.exit(1);
}
const notion = new Client({ auth: NOTION_API_KEY });

// --- ヘルパー関数 ---

const escapeNewlines = (text) => {
    if (typeof text !== 'string') return text;
    return text.replace(/\r\n|\n|\r/g, '\\n');
};

const getPlainTextFromProperty = (property) => {
    if (!property) return '';
    switch (property.type) {
        case 'title':
            return escapeNewlines(property.title[0]?.plain_text || '');
        case 'rich_text':
            return property.rich_text.map(t => escapeNewlines(t.plain_text)).join('\\n');
        case 'select':
            return property.select?.name || '';
        case 'multi_select':
            return property.multi_select.map(o => o.name).join(', ');
        case 'status':
            return property.status?.name || '';
        case 'people':
            return property.people.map(p => p.name).join(', ');
        case 'number':
            return property.number;
        case 'date':
            return property.date?.start || '';
        case 'checkbox':
            return property.checkbox;
        case 'url':
            return property.url || '';
        case 'email':
            return property.email || '';
        case 'phone_number':
            return property.phone_number || '';
        case 'formula':
            const formula = property.formula;
            switch (formula.type) {
                case 'string': return escapeNewlines(formula.string);
                case 'number': return formula.number;
                case 'boolean': return formula.boolean;
                case 'date': return formula.date?.start;
                default: return '';
            }
        case 'relation':
            return property.relation.map(r => r.id).join(', ');
        case 'rollup':
              const rollup = property.rollup;
              switch (rollup.type) {
                    case 'number': return rollup.number;
                    case 'date': return rollup.date?.start;
                    case 'array': return JSON.stringify(rollup.array);
                    default: return `[Rollup: ${rollup.type}]`;
              }
        default:
            return `[Unsupported Type: ${property.type}]`;
    }
};

/**
 * [新規] 指定されたブロックID（ページやブロック）から、サブページやDBを含めコンテンツを再帰的に取得します。
 * @param {string} blockId - 処理を開始するブロック（ページ）のID
 * @param {Client} notion - Notionクライアントインスタンス
 * @param {Set<string>} visited - 循環参照を避けるために訪問済みのIDを記録するSet
 * @param {string} indent - 階層構造を表現するためのインデント文字列
 * @returns {Promise<string>} 結合された全コンテンツ文字列
 */
async function getContentRecursively(blockId, notion, visited, indent = '') {
    if (visited.has(blockId)) {
        return `${indent}[循環参照をスキップ: ${blockId}]`;
    }
    visited.add(blockId);

    const allTextBlocks = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
        const response = await notion.blocks.children.list({
            block_id: blockId,
            start_cursor: startCursor,
            page_size: 100,
        });

        for (const block of response.results) {
            let blockText = '';
            if (block.type in block && block[block.type].rich_text) {
                blockText = block[block.type].rich_text.map(rt => rt.plain_text).join('');
            }

            if (block.type === 'child_page') {
                allTextBlocks.push(`\n${indent}--- Sub-Page: ${block.child_page.title} ---`);
                const subPageContent = await getContentRecursively(block.id, notion, visited, indent + '  ');
                allTextBlocks.push(subPageContent);
            } else if (block.type === 'child_database') {
                const dbTitle = block.child_database.title || 'Untitled Database';
                allTextBlocks.push(`\n${indent}--- Database: ${dbTitle} ---`);
                
                let dbHasMore = true;
                let dbStartCursor = undefined;
                while (dbHasMore) {
                    const dbResponse = await notion.databases.query({ database_id: block.id, start_cursor: dbStartCursor });
                    for (const page of dbResponse.results) {
                        const pageTitleProp = Object.values(page.properties).find(prop => prop.type === 'title');
                        const pageTitle = pageTitleProp?.title[0]?.plain_text || 'Untitled Page';
                        allTextBlocks.push(`\n${indent}  --- DB Entry: ${pageTitle} ---`);
                        const dbPageContent = await getContentRecursively(page.id, notion, visited, indent + '    ');
                        allTextBlocks.push(dbPageContent);
                    }
                    dbHasMore = dbResponse.has_more;
                    dbStartCursor = dbResponse.next_cursor;
                }
            } else if (blockText) {
                allTextBlocks.push(indent + blockText);
            }
        }
        hasMore = response.has_more;
        startCursor = response.next_cursor;
    }

    return allTextBlocks.map(escapeNewlines).join('\\n');
}

/**
 * 指定されたNotionデータベースからすべての投稿を動的に取得し、CSV形式の文字列を返します。
 * @param {string} databaseId - NotionデータベースID
 * @param {string} [name] - 保存名（オプション）。指定されない場合はDB名が使われる。
 * @returns {Promise<{csvString: string, safeName: string}>} 生成されたCSV文字列と安全なファイル名
 */
async function getNotionPostsAndConvertToCsv(databaseId, name) {
    if (!databaseId) {
        throw new Error("NotionデータベースIDが指定されていません。");
    }

    try {
        const dbInfo = await notion.databases.retrieve({ database_id: databaseId });
        const finalName = name || dbInfo.title[0]?.plain_text || databaseId;
        const safeName = finalName.replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');

        const titlePropertyName = Object.keys(dbInfo.properties).find(p => dbInfo.properties[p].type === 'title');
        if (!titlePropertyName) {
            throw new Error(`データベース (ID: ${databaseId}) に必須のタイトルプロパティが見つかりません。`);
        }
        console.log(`キータイトルとしてプロパティ "${titlePropertyName}" を特定しました。`);

        const otherPropertyNames = Object.keys(dbInfo.properties).filter(p => p !== titlePropertyName);
        const columns = ['page_id', 'Key_Title', 'created_time', 'last_edited_time', ...otherPropertyNames, 'page_content'];
        
        console.log(`データベース "${finalName}" (ID: ${databaseId}) から投稿を再帰的に取得中...`);
        
        const allRecords = [];
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await notion.databases.query({
                database_id: databaseId,
                start_cursor: startCursor,
                page_size: 100,
            });

            for (const page of response.results) {
                const record = {
                    page_id: page.id,
                    created_time: page.created_time,
                    last_edited_time: page.last_edited_time,
                };

                record['Key_Title'] = getPlainTextFromProperty(page.properties[titlePropertyName]);

                for (const propName of otherPropertyNames) {
                    record[propName] = getPlainTextFromProperty(page.properties[propName]);
                }

                // [修正] 再帰的なコンテンツ取得関数を呼び出す
                console.log(`  - ページ "${record['Key_Title']}" のコンテンツを再帰的に取得中...`);
                const visited = new Set();
                record.page_content = await getContentRecursively(page.id, notion, visited);
                
                allRecords.push(record);
            }
            hasMore = response.has_more;
            startCursor = response.next_cursor;
        }

        console.log(`✅ Notionから ${allRecords.length} 件の投稿を再帰的に取得しました。`);

        const csvString = stringify(allRecords, {
            header: true,
            columns: columns
        });

        return { csvString, safeName };

    } catch (err) {
        err.databaseId = databaseId;
        throw err;
    }
}

/**
 * データベースを処理し、CSVファイルとして保存するヘルパー関数
 */
async function processAndSaveDatabase(databaseId, outputName) {
    const trimmedDbId = databaseId ? databaseId.trim() : null;
    if (!trimmedDbId) {
        console.warn("--- スキップ: 空のデータベースIDが提供されました ---");
        return;
    }

    try {
        console.log(`\n--- データベース処理開始: ${trimmedDbId} ---`);
        const { csvString, safeName } = await getNotionPostsAndConvertToCsv(trimmedDbId, outputName);
        const filePath = `${safeName}_recursive.csv`;
        fs.writeFileSync(filePath, csvString);
        console.log(`✅ CSV出力完了: ${filePath}`);
    } catch (error) {
        if (error.code === 'object_not_found') {
            console.error(`--- データベース処理失敗: ID "${error.databaseId}" が見つかりません。IDが正しいか、インテグレーションがデータベースに共有されているか確認してください。 ---`);
        } else {
            console.error(`--- データベース処理失敗: ${error.databaseId || trimmedDbId}, エラー: ${error.message} ---`);
        }
    }
}

// --- コマンドラインからの実行部分 ---
if (require.main === module) {
    const main = async () => {
        const databaseId = process.argv[2];
        const outputName = process.argv[3];

        if (!databaseId) {
            console.error("❌ NotionデータベースIDを指定してください。");
            console.error("使用法: node <ファイル名>.js <database_id> [output_name]");
            process.exit(1);
        }

        await processAndSaveDatabase(databaseId, outputName);
    };

    main().catch(err => {
        console.error(`❌ 予期せぬエラーが発生しました: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    getNotionPostsAndConvertToCsv
};
