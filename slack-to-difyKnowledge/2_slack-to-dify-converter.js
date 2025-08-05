const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { stringify } = require('csv-stringify');
const { Readable } = require('stream');

const MAX_BYTES_PER_FILE = 14000 * 1024; // Difyのアップロード制限を考慮したファイルサイズ上限

/**
 * Slackのタイムスタンプ（秒）を 'YYYY/MM/DD HH:MM' 形式の文字列に変換する関数
 * @param {string} ts - Slackのタイムスタンプ文字列
 * @returns {string} フォーマットされた日時文字列
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  // Slackのタイムスタンプは秒単位なので、1000を掛けてミリ秒に変換
  const date = new Date(parseFloat(ts) * 1000);

  const year = date.getFullYear();
  // getMonth()は0から始まるため+1する。padStartで0埋めして2桁に。
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');

  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

/**
 * テキストから不要な改行を削除・統一するヘルパー関数
 */
function cleanText(text) {
    if (!text) return '';
    return text.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
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
    const parentThreads = records.filter(row => !row.thread_ts || row.thread_ts === '' || row.ts === row.thread_ts);
    const childThreads = records.filter(row => row.thread_ts && row.thread_ts !== '' && row.ts !== row.thread_ts);
    const transformedData = parentThreads.map(parent => {
        const parentTs = parent.ts; 
        const parentText = parent.text || '';
        const parentUrl = parent.thread_url || '';

        const children = childThreads
            .filter(child => child.thread_ts === parentTs)
            .map(child => {
                const time = formatTimestamp(child.ts); // タイムスタンプを整形
                const user = child.user || '';           // ユーザーIDを取得
                const text = child.text || '';
                // 「時刻 ユーザーID: テキスト」の形式で文字列を返す
                return `${time} ${user}: ${text}`;
            });
        let childText = children.join('\n');
        // 回答の末尾に参照元URLを追加
        if (parentUrl) {
            childText += `\n参照元スレッド: ${parentUrl}`;
        }
        return {
            parent_timestamp: formatTimestamp(parentTs), // parentTsを関数で囲む
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

// --- コマンドラインからの独立実行用の部分 ---
if (require.main === module) {
    const inputFilePath = process.argv[2];

    if (!inputFilePath) {
        console.error("❌ 変換元のCSVファイルを引数で指定してください。例: node your_script.js slack_channel_name.csv");
        process.exit(1);
    }

    const outputDir = path.dirname(inputFilePath);
    const inputFileExtension = path.extname(inputFilePath);
    const inputFileNameWithoutExt = path.basename(inputFilePath, inputFileExtension);

    fs.readFile(inputFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`❌ ファイルの読み込みに失敗しました: ${err.message}`);
            process.exit(1);
        }

        convertCsvStringToDifyReadyCsvString(data)
            .then(difyCsvs => {
                if (difyCsvs.length === 0) {
                    console.log('変換後のデータがないため、ファイルは出力されませんでした。');
                    return;
                }
                
                difyCsvs.forEach((csvContent, index) => {
                    const outputFileName = `${inputFileNameWithoutExt}_dify_${index + 1}.csv`;
                    const outputFilePath = path.join(outputDir, outputFileName);
                    fs.writeFileSync(outputFilePath, csvContent);
                    console.log(`✅ Dify用CSVファイルを出力しました: ${outputFilePath}`);
                });
            })
            .catch(error => {
                console.error(`❌ 変換中にエラーが発生しました: ${error.message}`);
                process.exit(1);
            });
    });
}

module.exports = {
    convertToDifyReadyCsv: convertCsvStringToDifyReadyCsvString
};