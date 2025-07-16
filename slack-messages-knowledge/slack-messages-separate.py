import csv

input_file = r"csvのパス"
rows_per_file = 30 #分割したい行数

with open(input_file, 'r', encoding='utf-8') as f:
    reader = csv.reader(f)
    header = next(reader)
    file_count = 1
    rows = []
    for row in reader:
        rows.append(row)
        if len(rows) == rows_per_file:
            with open(f'ファイル名_{file_count}.csv', 'w', encoding='utf-8', newline='') as out:
                writer = csv.writer(out)
                writer.writerow(header)
                writer.writerows(rows)
            file_count += 1
            rows = []
    if rows:
        with open(f'ファイル名_{file_count}.csv', 'w', encoding='utf-8', newline='') as out:
            writer = csv.writer(out)
            writer.writerow(header)
            writer.writerows(rows)
