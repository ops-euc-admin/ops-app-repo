/**
 * 2_notionDB-to-dify-converter_generic.js
 * * Notion DBから取得したCSV文字列を、Difyナレッジベース用の「汎用ドキュメント」形式に変換します。
 * * [変更点] Q&A形式を廃止し、ページの全情報を一つのテキストブロックにまとめる方式に変更しました。
 * * [変更点] 不安定なAI要約機能とキーワード抽出機能を削除しました。
 * * [修正] 各セクション間の不要な改行を削除し、意図しないチャンク分割を防止するようにしました。
 * * 実行方法:
 * node 2_notionDB-to-dify-converter_generic.js <入力CSVファイルパス>
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
require('dotenv').config();

// Difyのアップロード制限を考慮した安全なファイルサイズ上限 (14MB)
const MAX_BYTES_PER_FILE = 14 * 1024 * 1024;

/**
 * CSV文字列を受け取り、Difyアップロード用のCSV文字列の配列を返します。
 * @param {string} inputCsvString - 変換元のCSVデータ（文字列形式）
 * @returns {Promise<Array<string>>} Dify形式に変換・分割されたCSV文字列の配列
 */
async function convertToDifyReadyCsv(inputCsvString) {
    console.log('Difyナレッジ用にCSVを「汎用ドキュメント」形式で処理中...');
    const records = parse(inputCsvString, { columns: true, skip_empty_lines: true });

    const transformedData = [];
    for (const [index, record] of records.entries()) {
        console.log(`  - レコードを処理中 ${index + 1}/${records.length}...`);
        
        const contentParts = [];
        
        // 1. タイトルを追加
        const title = record.Key_Title || 'No Title';
        contentParts.push(`# ${title}`);

        // 2. メタデータ（プロパティ）を追加
        const metadataParts = [];
        for (const key in record) {
            // コンテンツのキーと重複するものを除き、値が存在するものだけを追加
            if (key !== 'Key_Title' && key !== 'page_content' && record[key]) {
                metadataParts.push(`- **${key}**: ${record[key]}`);
            }
        }
        if (metadataParts.length > 0) {
            contentParts.push('## Properties');
            contentParts.push(metadataParts.join('\n'));
        }

        // 3. 本文コンテンツを追加
        contentParts.push('## Content');
        contentParts.push(record.page_content || 'No content available.');

        // [修正] 全てのパーツを「単一改行」で結合して、一つの連続したテキストブロックにする
        const documentText = contentParts.join('\n');
        transformedData.push({ text: documentText });
    }
    console.log(`\n✅ ${transformedData.length} 件のレコードを変換しました。ファイルサイズに基づき分割します...`);

    // --- 変換後のデータをサイズに基づいて分割 ---
    const outputCsvStrings = [];
    const headers = ['text']; // Difyの汎用ドキュメントは 'text' カラムを想定
    let currentRows = [];
    let currentByteSize = Buffer.byteLength(stringify([], { header: true, columns: headers }), 'utf8');

    for (const row of transformedData) {
        const rowString = stringify([row], { header: false });
        const rowByteSize = Buffer.byteLength(rowString, 'utf8');

        if (currentByteSize + rowByteSize > MAX_BYTES_PER_FILE && currentRows.length > 0) {
            outputCsvStrings.push(stringify(currentRows, { header: true, columns: headers }));
            currentRows = [];
            currentByteSize = Buffer.byteLength(stringify([], { header: true, columns: headers }), 'utf8');
        }

        currentRows.push(row);
        currentByteSize += rowByteSize;
    }

    if (currentRows.length > 0) {
        outputCsvStrings.push(stringify(currentRows, { header: true, columns: headers }));
    }
    
    console.log(`✨ データを ${outputCsvStrings.length} 個のCSVチャンクに分割しました。`);
    return outputCsvStrings;
}


// --- スクリプト実行部分 ---

// このスクリプトが直接実行された場合にのみ動作
if (require.main === module) {
    const inputFilePath = process.argv[2];
    if (!inputFilePath) {
        console.error('❌ 使用法: node <ファイル名>.js <入力CSVファイル>');
        process.exit(1);
    }
    if (!fs.existsSync(inputFilePath)) {
        console.error(`❌ エラー: ファイルが見つかりません - ${inputFilePath}`);
        process.exit(1);
    }

    (async () => {
        try {
            const fileContent = fs.readFileSync(inputFilePath, 'utf8');
            const csvChunks = await convertToDifyReadyCsv(fileContent);

            const baseFileName = path.basename(inputFilePath, '.csv');
            const outputDir = path.dirname(inputFilePath);
            
            for(let i = 0; i < csvChunks.length; i++) {
                const outputFilePath = path.join(outputDir, `${baseFileName}_dify_generic_part${i + 1}.csv`);
                fs.writeFileSync(outputFilePath, csvChunks[i]);
                console.log(`📦 分割ファイル ${i + 1} を保存しました: ${outputFilePath}`);
            }
        } catch (err) {
            console.error(`❌ ${inputFilePath} の処理に失敗しました: ${err.message}`);
            process.exit(1);
        }
    })();
}

// 他のモジュールから関数をインポートして使用できるようにエクスポート
module.exports = {
    convertToDifyReadyCsv
};
