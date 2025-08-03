const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { stringify } = require('csv-stringify');
const { Readable } = require('stream');

const MAX_BYTES_PER_FILE = 14000 * 1024; // Difyのアップロード制限を考慮したファイルサイズ上限

/**
 * テキストから不要な改行を削除・統一するヘルパー関数
 */
function cleanText(text) {
    if (!text) return '';
    return text.replace(/\n{2,}/g, '\n').trim();
}

// 関数全体を、CSV文字列の配列を返すように修正
/**
 * CSVデータ（文字列）をDifyに適した形式に変換し、ファイルサイズ上限に基づいて分割したCSV文字列の配列を返します。
 * @param {string} csvString - 変換元のCSVデータ（文字列）
 * @returns {Promise<Array<string>>} 分割されたDify形式のCSV文字列の配列
 */
async function convertCsvStringToDifyReadyCsvString(csvString) {
    console.log('Dify用データへの変換と分割を開始します...');

    // 1. 入力されたCSV文字列をパースしてレコード配列を作成
    const records = [];
    if (csvString && csvString.trim()) {
        await new Promise((resolve, reject) => {
            Readable.from(csvString)
                .pipe(csv())
                .on('data', (data) => records.push(data))
                .on('end', () => resolve())
                .on('error', (err) => reject(err));
        });
    }
    
    // レコードが0件の場合は空の配列を返して終了
    if (records.length === 0) {
        console.log("変換対象のレコードが0件でした。");
        return [];
    }

    // 2. スレッドを親と子に分離し、Difyが要求する形式に変換
    const parentThreads = records.filter(row => !row.thread_ts || row.thread_ts === '' || row.timestamp === row.thread_ts);
    const childThreads = records.filter(row => row.thread_ts && row.thread_ts !== '' && row.timestamp !== row.thread_ts);
    const transformedData = parentThreads.map(parent => {
        const parentTs = parent.timestamp;
        const parentText = parent.text || '';
        const parentUrl = parent.thread_url || '';

        const children = childThreads
            .filter(child => child.thread_ts === parentTs)
            .map(child => child.text || '');
        let childText = children.join('\n');
        // 回答の末尾に参照元URLを追加
        if (parentUrl) {
            childText += `\n参照元スレッド: ${parentUrl}`;
        }
        return {
            parent_timestamp: parentTs,
            parent_text: cleanText(parentText),
            child_text: cleanText(childText)
        };
    });

    // 3. 変換後のデータをサイズに基づいて分割し、CSV文字列の配列を作成
    const csvParts = [];
    let currentRows = [];
    let currentByteSize = 0;
    const headers = ['parent_timestamp', 'parent_text', 'child_text'];

    // ヘッダーのバイトサイズを事前に計算
    const headerString = await new Promise((resolve, reject) => {
        stringify([], { header: true, columns: headers }, (err, result) => {
            if (err) reject(err); resolve(result);
        });
    });
    const headerByteSize = Buffer.byteLength(headerString, 'utf8');
    currentByteSize += headerByteSize;

    for (const row of transformedData) {
        // これから追加する行のバイトサイズを計算
        const rowString = await new Promise((resolve, reject) => {
            stringify([row], { header: false }, (err, result) => {
                if (err) reject(err); resolve(result);
            });
        });
        const rowByteSize = Buffer.byteLength(rowString, 'utf8');

        // もし現在のチャンクにこの行を追加すると上限を超える場合、現在のチャンクを確定させる
        if (currentByteSize + rowByteSize > MAX_BYTES_PER_FILE && currentRows.length > 0) {
            const partCsvString = await new Promise((resolve, reject) => {
                stringify(currentRows, { header: true, columns: headers }, (err, result) => {
                    if (err) reject(err); resolve(result);
                });
            });
            csvParts.push(partCsvString);
            
            // 次のチャンクのためにリセット
            currentRows = [];
            currentByteSize = headerByteSize;
        }
        
        // 現在のチャンクに行を追加
        currentRows.push(row);
        currentByteSize += rowByteSize;
    }

    // ループ終了後、残っている行があれば最後のチャンクとして確定させる
    if (currentRows.length > 0) {
        const partCsvString = await new Promise((resolve, reject) => {
            stringify(currentRows, { header: true, columns: headers }, (err, result) => {
                if (err) reject(err); resolve(result);
            });
        });
        csvParts.push(partCsvString);
    }

    console.log(`✅ 変換と分割が完了しました。${csvParts.length}個のパーツが作成されました。`);
    return csvParts;
}

// --- コマンドラインからの独立実行用の部分 (変更なし) ---
if (require.main === module) {
    // ... (この部分は変更なし)
}

module.exports = {
    convertToDifyReadyCsv: convertCsvStringToDifyReadyCsvString
};
