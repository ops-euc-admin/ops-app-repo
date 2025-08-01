const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { stringify } = require('csv-stringify');

const MAX_BYTES_PER_FILE = 14000 * 1024;

async function processCsvFile(inputFilePath) {
    console.log(`Processing ${inputFilePath}...`);
    const records = [];

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

    const parentThreads = records.filter(row =>
        !row.thread_ts || row.thread_ts === '' || row.timestamp === row.thread_ts
    );

    const childThreads = records.filter(row =>
        row.thread_ts && row.thread_ts !== '' && row.timestamp !== row.thread_ts
    );

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

    const baseFileName = path.basename(inputFilePath, '.csv');
    let fileCount = 1;
    let currentByteSize = 0;
    let currentRows = [];
    const headers = ['parent_timestamp', 'parent_text', 'child_text'];

    for (const row of transformedData) {
        // --- 修正箇所 ---
        const rowString = await new Promise((resolve, reject) => {
            stringify([row], { header: false }, (err, result) => {
                if (err) reject(err);
                resolve(result);
            });
        });
        // --- 修正箇所ここまで ---

        const rowByteSize = Buffer.byteLength(rowString, 'utf8');

        if (currentByteSize + rowByteSize > MAX_BYTES_PER_FILE && currentRows.length > 0) {
            const outputFilePath = `${baseFileName}_notion_ready_part${fileCount}.csv`;
            await writeCsvFile(outputFilePath, headers, currentRows);
            console.log(`Saved part ${fileCount} of ${inputFilePath} to ${outputFilePath}`);

            fileCount++;
            currentByteSize = 0;
            currentRows = [];
        }

        currentRows.push(row);
        currentByteSize += rowByteSize;
    }

    if (currentRows.length > 0) {
        const outputFilePath = `${baseFileName}_notion_ready_part${fileCount}.csv`;
        await writeCsvFile(outputFilePath, headers, currentRows);
        console.log(`Saved part ${fileCount} of ${inputFilePath} to ${outputFilePath}`);
    }
}

async function writeCsvFile(filePath, headers, data) {
    const output = await new Promise((resolve, reject) => {
        stringify(data, { header: true, columns: headers }, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
    fs.writeFileSync(filePath, output);
}

async function main() {
    const csvFilePaths = process.argv.slice(2);

    if (csvFilePaths.length === 0) {
        console.log('Usage: node processCsv.js <csv_file1.csv> [csv_file2.csv ...]');
        console.log('Example: node processCsv.js slack_export_2023_01_01.csv slack_export_2023_01_02.csv');
        return;
    }

    for (const filePath of csvFilePaths) {
        if (!fs.existsSync(filePath)) {
            console.error(`Error: File not found - ${filePath}. Skipping.`);
            continue;
        }
        await processCsvFile(filePath);
    }
    console.log('All CSV files processed.');
}

main().catch(console.error);