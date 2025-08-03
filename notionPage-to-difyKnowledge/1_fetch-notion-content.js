/**
 * 1_fetch-notion-content.js
 * * 指定されたNotionDBアイテムまたは単一ページからコンテンツを再帰的に取得し、CSV形式の文字列に変換します。
 * * [変更点] ページ内に含まれるサブページや子データベースのコンテンツもすべて取得するよう、再帰処理を追加しました。
 * * 実行方法:
 * node 1_fetch-notion-content.js <page_id> [output_name]
 */
const { Client } = require("@notionhq/client");
const { stringify } = require("csv-stringify/sync");
const fs = require("fs");
require("dotenv").config();

// --- 環境変数チェック ---
const NOTION_API_KEY = process.env.NOTION_API_KEY;
if (!NOTION_API_KEY) {
    const message = '環境変数 NOTION_API_KEY が設定されていません。';
    console.error(`❌ ${message}`);
    if (require.main !== module) throw new Error(message);
    process.exit(1);
}
const notion = new Client({ auth: NOTION_API_KEY });

// --- ヘルパー関数 ---

const normalizePageId = (pageId) => {
    if (typeof pageId !== 'string') return pageId;
    const noHyphens = pageId.replace(/-/g, '');
    const potentialId = noHyphens.slice(-32);
    if (potentialId.length === 32 && /^[a-fA-F0-9]{32}$/.test(potentialId)) {
        return `${potentialId.slice(0, 8)}-${potentialId.slice(8, 12)}-${potentialId.slice(12, 16)}-${potentialId.slice(16, 20)}-${potentialId.slice(20)}`;
    }
    console.warn(`⚠️ ページID "${pageId}" は正規のNotion ID形式に変換できませんでした。`);
    return pageId;
};

const escapeNewlines = (text) => (typeof text === 'string' ? text.replace(/\r\n|\n|\r/g, '\\n') : text);

const getPlainTextFromProperty = (property) => {
    if (!property) return '';
    switch (property.type) {
        case 'title': return escapeNewlines(property.title[0]?.plain_text || '');
        case 'rich_text': return property.rich_text.map(t => escapeNewlines(t.plain_text)).join('\\n');
        case 'select': return property.select?.name || '';
        case 'multi_select': return property.multi_select.map(o => o.name).join(', ');
        case 'status': return property.status?.name || '';
        case 'people': return property.people.map(p => p.name).join(', ');
        case 'number': return property.number;
        case 'date': return property.date?.start || '';
        case 'checkbox': return property.checkbox;
        case 'url': return property.url || '';
        case 'email': return property.email || '';
        case 'phone_number': return property.phone_number || '';
        case 'formula':
            const formula = property.formula;
            switch (formula.type) {
                case 'string': return escapeNewlines(formula.string);
                case 'number': return formula.number;
                case 'boolean': return formula.boolean;
                case 'date': return formula.date?.start;
                default: return '';
            }
        case 'relation': return property.relation.map(r => r.id).join(', ');
        case 'rollup':
            const rollup = property.rollup;
            switch (rollup.type) {
                case 'number': return rollup.number;
                case 'date': return rollup.date?.start;
                case 'array': return JSON.stringify(rollup.array);
                default: return `[Rollup: ${rollup.type}]`;
            }
        default: return `[Unsupported Type: ${property.type}]`;
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

// --- メイン処理関数 ---

async function fetchNotionContent(target) {
    const { type, source_id, name } = target;
    if (!type || !source_id) {
        throw new Error("処理対象のタイプまたはソースIDが指定されていません。");
    }

    try {
        const safeName = name.replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');
        const formattedPageId = normalizePageId(source_id);
        
        console.log(`📄 ページコンテンツを再帰的に取得中: "${name}" (ID: ${formattedPageId})`);
        
        const page = await notion.pages.retrieve({ page_id: formattedPageId });
        const titlePropertyName = Object.keys(page.properties).find(p => page.properties[p].type === 'title');
        if (!titlePropertyName) throw new Error(`ページにタイトルプロパティが見つかりません。`);

        const propertyNames = Object.keys(page.properties);
        const columns = ['page_id', 'Key_Title', 'created_time', 'last_edited_time', ...propertyNames.filter(p => p !== titlePropertyName), 'page_content'];
        
        const record = {
            page_id: page.id,
            created_time: page.created_time,
            last_edited_time: page.last_edited_time,
        };
        record['Key_Title'] = getPlainTextFromProperty(page.properties[titlePropertyName]);
        for (const propName of propertyNames) {
            if (propName !== titlePropertyName) {
                record[propName] = getPlainTextFromProperty(page.properties[propName]);
            }
        }
        
        // [修正] 再帰的なコンテンツ取得関数を呼び出す
        const visited = new Set();
        record.page_content = await getContentRecursively(page.id, notion, visited);

        console.log(`✅ 再帰的なコンテンツ取得完了。CSVに変換します...`);
        const csvString = stringify([record], { header: true, columns: columns });
        return { csvString, safeName };

    } catch (err) {
        err.sourceInfo = `${type}:${source_id}`;
        throw err;
    }
}

// --- コマンドラインからの独立実行用 ---
if (require.main === module) {
    const main = async () => {
        const sourceId = process.argv[2];
        const outputName = process.argv[3] || sourceId;

        if (!sourceId) {
            console.error("❌ 引数が正しくありません。");
            console.error("使用法: node 1_fetch-notion-content.js <page_id> [output_name]");
            process.exit(1);
        }

        try {
            console.log(`\n--- 処理開始: page - ${sourceId} ---`);
            const target = { type: 'notionPage', source_id: sourceId, name: outputName };
            const { csvString, safeName } = await fetchNotionContent(target);
            const filePath = `${safeName}_recursive.csv`;
            fs.writeFileSync(filePath, csvString);
            console.log(`✅ CSV出力完了: ${filePath}`);
        } catch (error) {
            if (error.code === 'object_not_found') {
                console.error(`--- 処理失敗: ID "${error.sourceInfo}" が見つかりません。IDが正しいか、インテグレーションが共有されているか確認してください。 ---`);
            } else {
                console.error(`--- 処理失敗: ${error.sourceInfo || sourceId}, エラー: ${error.message} ---`);
            }
            process.exit(1);
        }
    };

    main().catch(err => {
        console.error(`❌ 予期せぬエラーが発生しました: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    fetchNotionContent
};
