# PowerShellスクリプト: WindowsでのエラーをSlackに通知する
# このスクリプトは、Windowsで発生したエラーをSlackに通知するためのものです。 
# 事前にSlackのIncoming Webhookを設定し、Webhook URLを取得しておく必要があります。

# PowerShellスクリプトを実行する前に、以下の手順を確認してください。
# 1. SlackのワークスペースでIncoming Webhookを設定し、Webhook URLを取得します。
# 2. このスクリプトをPowerShellで実行できるようにします。
# 3. スクリプトを実行する際は、適切な権限を持つユーザーで実行してください。

# PowerShellスクリプト: WindowsでのエラーをSlackに通知する
    
# --- 設定項目 ---
$webhookUrl = "https://hooks.slack.com/services/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" # 取得したWebhook URL
$message = @{
    "text" = "【:warning: 警告】AI/EUCサーバーでエラーが発生しました。サーバーのイベントビューアーを確認してください。"
    "username" = "AI/EUCサーバー"
    "icon_emoji" = ":robot_face:"
} | ConvertTo-Json

# --- Slackへ通知 ---
Invoke-RestMethod -Uri $webhookUrl -Method Post -Body $message -ContentType 'application/json'