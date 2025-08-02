const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { stringify } = require('csv-stringify');
const { Readable } = require('stream');

const MAX_BYTES_PER_FILE = 14000 * 1024; // Difyのアップロード制限を考慮したファイルサイズ上限

/**
 * CSVデータ（文字列）をDifyに適した形式に変換します。
 * この関数は他のモジュールから呼び出されることを想定しています。
 * @param {string} csvString - 変換元のCSVデータ（文字列）
 * @returns {Promise<string>} Dify形式のCSV文字列
 */
async function convertCsvStringToDifyReadyCsvString(csvString) {
    console.log('Converting CSV data to Dify-ready format...');
    
    const records = [];
    
    // CSV文字列をReadableストリームとして扱い、csv-parserでパース
    await new Promise((resolve, reject) => {
        Readable.from(csvString)
            .pipe(csv())
            .on('data', (data) => records.push(data))
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });

    // スレッドの親と子を分離
    const parentThreads = records.filter(row =>
        !row.thread_ts || row.thread_ts === '' || row.timestamp === row.thread_ts
    );

    const childThreads = records.filter(row =>
        row.thread_ts && row.thread_ts !== '' && row.timestamp !== row.thread_ts
    );

    // Dify形式にデータを変換
    const transformedData = parentThreads.map(parent => {
        const parentTs = parent.timestamp;
        const parentText = parent.text || '';
        const children = childThreads
            .filter(child => child.thread_ts === parentTs)
            .map(child => child.text || '');
        const childText = children.join('\n');

        return {
            parent_timestamp: parentTs,
            parent_text: parentText,
            child_text: childText
        };
    });

    // 変換されたデータをCSV文字列として生成
    const headers = ['parent_timestamp', 'parent_text', 'child_text'];
    const difyCsvString = await new Promise((resolve, reject) => {
        stringify(transformedData, { header: true, columns: headers }, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });

    console.log('✅ Conversion to Dify-ready CSV string completed.');
    return difyCsvString;
}

/**
 * データを指定されたパスにCSVファイルとして書き出す
 * @param {string} filePath - 出力するファイルパス
 * @param {Array<string>} headers - ヘッダーの配列
 * @param {Array<Object>} data - 書き出すデータの配列
 */
async function writeCsvFile(filePath, headers, data) {
    const output = await new Promise((resolve, reject) => {
        stringify(data, { header: true, columns: headers }, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
    fs.writeFileSync(filePath, output);
}

// --- コマンドラインからの独立実行用の部分 ---
// スクリプトが直接 'node dify-converter.js' のように実行された場合にのみこのブロックが動作します。
if (require.main === module) {
    const inputFilePath = process.argv[2];

    if (!inputFilePath) {
        console.log('Usage: node dify-converter.js <input_csv_file.csv>');
        console.log('Example: node dify-converter.js slack_general.csv');
        process.exit(1);
    }

    if (!fs.existsSync(inputFilePath)) {
        console.error(`Error: File not found - ${inputFilePath}.`);
        process.exit(1);
    }

    async function main() {
        try {
            console.log(`Processing ${inputFilePath} for Dify-ready CSV output...`);
            
            const records = [];

            // 入力CSVファイルを読み込み、パース
            await new Promise((resolve, reject) => {
                fs.createReadStream(inputFilePath)
                    .pipe(csv())
                    .on('data', (data) => records.push(data))
                    .on('end', () => {
                        console.log(`Finished reading ${records.length} records from ${inputFilePath}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`Error reading CSV file ${inputFilePath}:`, err);
                        reject(err);
                    });
            });

            // スレッドの親と子を分離
            const parentThreads = records.filter(row =>
                !row.thread_ts || row.thread_ts === '' || row.timestamp === row.thread_ts
            );

            const childThreads = records.filter(row =>
                row.thread_ts && row.thread_ts !== '' && row.timestamp !== row.thread_ts
            );

            // Dify形式にデータを変換（オブジェクトの配列として保持）
            const transformedData = parentThreads.map(parent => {
                const parentTs = parent.timestamp;
                const parentText = parent.text || '';
                const children = childThreads
                    .filter(child => child.thread_ts === parentTs)
                    .map(child => child.text || '');
                const childText = children.join('\n');

                return {
                    parent_timestamp: parentTs,
                    parent_text: parentText,
                    child_text: childText
                };
            });

            // 変換されたデータをファイルに書き出す（サイズ分割も考慮）
            const baseFileName = path.basename(inputFilePath, '.csv');
            let fileCount = 1;
            let currentByteSize = 0;
            let currentRows = [];
            const headers = ['parent_timestamp', 'parent_text', 'child_text'];

            for (const row of transformedData) {
                // stringifyで個々の行を文字列化してバイトサイズを計測
                const rowString = await new Promise((resolve, reject) => {
                    // ここで `row` はオブジェクトなので、正しく文字列化されます
                    stringify([row], { header: false, columns: headers }, (err, result) => {
                        if (err) reject(err);
                        resolve(result);
                    });
                });
                const rowByteSize = Buffer.byteLength(rowString, 'utf8');

                if (currentByteSize + rowByteSize > MAX_BYTES_PER_FILE && currentRows.length > 0) {
                    const outputFilePath = `${baseFileName}_dify_ready_part${fileCount}.csv`;
                    await writeCsvFile(outputFilePath, headers, currentRows);
                    console.log(`✅ Saved part ${fileCount} to ${outputFilePath}`);
                    
                    fileCount++;
                    currentByteSize = 0;
                    currentRows = [];
                }

                currentRows.push(row);
                currentByteSize += rowByteSize;
            }

            if (currentRows.length > 0) {
                const outputFilePath = `${baseFileName}_dify_ready_part${fileCount}.csv`;
                await writeCsvFile(outputFilePath, headers, currentRows);
                console.log(`✅ Saved part ${fileCount} to ${outputFilePath}`);
            }
            console.log('All data has been converted and saved to files.');

        } catch (err) {
            console.error(`❌ Failed to process ${inputFilePath}: ${err.message}`);
            process.exit(1);
        }
    }

    main().catch(console.error);
}

// 他のファイルから require で呼び出せるように関数を公開
module.exports = {
    convertToDifyReadyCsv: convertCsvStringToDifyReadyCsvString // 関数名を分かりやすく変更
};
