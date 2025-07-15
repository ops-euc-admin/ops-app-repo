import pandas as pd

# CSVファイルを読み込む
df = pd.read_csv('ファイル名')

# 親スレッドの抽出
parent_df = df[
    (df['thread_ts'].isnull()) | 
    (df['thread_ts'] == '') | 
    (df['timestamp'] == df['thread_ts'])
]

# 子スレッドの抽出
child_df = df[
    (df['thread_ts'].notnull()) & 
    (df['thread_ts'] != '') & 
    (df['timestamp'] != df['thread_ts'])
]

# 親ごとに子をまとめる
result = []
for _, parent in parent_df.iterrows():
    parent_ts = parent['timestamp']
    parent_text = parent['text']
    # 親のtimestampに紐づく子スレッドを抽出
    children = child_df[child_df['thread_ts'] == parent_ts]['text'].tolist()
    child_text = '\n'.join(children)
    result.append({
        'parent_timestamp': parent_ts,
        'parent_text': parent_text,
        'child_text': child_text
    })

# 新しいCSVとして保存
result_df = pd.DataFrame(result)
result_df.to_csv('dify_ready.csv', index=False)
