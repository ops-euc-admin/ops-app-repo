このドキュメントは**Windows、macOS、Linuxの全OS対応**です。  

---

## 1. 事前準備

### 1-1. Pythonのインストール

- [Python公式サイト](https://www.python.org/)からお使いのOSに合った「Python 3.x」をダウンロードし、インストーラーを実行
- インストール途中の「Add Python to PATH」に必ずチェックを入れる

> ※ インストール後、「python --version」または「python3 --version」で確認  
> 正しくインストールされていれば「Python 3.x.x」と表示されます[9]。

### 1-2. VSCodeのインストール

- [VSCode公式サイト](https://code.visualstudio.com/)からダウンロード
- インストール後は起動し、左側の「拡張機能」アイコン（四角が4つ集まったアイコン）をクリックし「Python」と検索、「Python」拡張機能（Microsoft製）を追加・有効化[5][11]  
  - 「Jupyter」拡張も追加しておくと便利です

---

## 2. プロジェクトと仮想環境のセットアップ

### 2-1. プロジェクト用フォルダを作成＆VSCodeで開く

- 任意の場所に新しいフォルダを作成（例：`myproject`）
- VSCodeで【ファイル】→【フォルダーを開く】からこのフォルダを選択

### 2-2. ターミナルを開く

- VSCode画面：`Ctrl + Shift + @`（Macは`command + shift + @`）、もしくは【表示】→【ターミナル】
- 以降は**VSCodeのターミナル**でコマンドを入力します

### 2-3. 仮想環境の作成

- 以下のコマンドを実行（どのOSでもOK）
`python -m venv .venv`

- `.venv` という名前の仮想環境フォルダが作られます

### 2-4. 仮想環境の有効化

| OS        | コマンド                     |
|-----------|-----------------------------|
| Windows   | `.\.venv\Scripts\activate`  |
| macOS/Linux | `source .venv/bin/activate` |

> ※ プロンプトの先頭が `(.venv)` などになれば有効化成功。

### 2-5. VSCodeに仮想環境を認識させる

- `Ctrl + Shift + P` を押し、「Python: インタープリターを選択」と入力しEnter
- 出てきたリストから「.venv」（またはさきほど作成した仮想環境名）の付いたものを選択  
  → これでVSCode上のPython実行環境も仮想環境に切り替わります。

---

## 3. 必要なパッケージのインストール

仮想環境が有効化された状態で、ターミナルで以下を順番に実行
- `pip install pandas`

---

## 4. Pythonスクリプトの作成・実行

### 4-1. 新しいPythonファイルの作成

- VSCodeのサイドバーで「新しいファイル」をクリックし、ファイル名を `main.py` など「.py」で保存

### 4-2. スクリプト

- `slack-messages-knowledge.py`

---

### 4-3. スクリプトの実行

- ターミナルで `python main.py` と入力

- ファイル右上の【▶】マークを押しても実行できます
- `dify_ready.csv` という新しいファイルが生成されれば成功です

---


