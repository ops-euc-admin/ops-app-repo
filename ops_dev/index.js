require('dotenv').config();
const { App } = require('@slack/bolt');

// 会話履歴を保存するオブジェクト（ユーザーIDをキーとする）
const conversationHistory = {};

// 各ユーザーの最終活動時刻を記録
const lastActivityTime = {};

// 処理中のユーザーを記録（重複防止）
const processingUsers = new Set();

// エラー処理済みのメッセージを記録（重複エラー防止）
const errorHandledMessages = new Set();

// 自動リセットの間隔（ミリ秒）：1時間 = 60 * 60 * 1000
const AUTO_RESET_INTERVAL = 60 * 60 * 1000;

// 環境変数からSlackトークンを読み込み
const app = new App({
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  token: process.env.SLACK_BOT_TOKEN,
  logLevel: 'debug'
});

// 相談カテゴリの選択肢
const CONSULTATION_CATEGORIES = [
  { text: "SPEEDAについて", value: "SPEEDAについて" },
  { text: "プロジェクト推進方針について", value: "プロジェクト推進方針について" },
  { text: "NPL販売について", value: "NPL販売について" },
  { text: "NP法人プランについて", value: "NP法人プランについて" },
  { text: "ERプランについて", value: "ERプランについて" },
  { text: "その他", value: "その他" }
];

// Block Kit UIを生成する関数
function createConsultationBlocks() {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "どのような内容についてご相談されますか？カテゴリを選択して、相談内容を入力してください。"
      }
    },
    {
      type: "input",
      block_id: "category_select",
      element: {
        type: "static_select",
        action_id: "consultation_category",
        placeholder: {
          type: "plain_text",
          text: "カテゴリを選択してください"
        },
        options: CONSULTATION_CATEGORIES.map(cat => ({
          text: {
            type: "plain_text",
            text: cat.text
          },
          value: cat.value
        }))
      },
      label: {
        type: "plain_text",
        text: "相談カテゴリ"
      }
    },
    {
      type: "input",
      block_id: "consultation_input",
      element: {
        type: "plain_text_input",
        action_id: "consultation_text",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: "相談内容を詳しく教えてください..."
        }
      },
      label: {
        type: "plain_text",
        text: "相談内容"
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "相談する"
          },
          style: "primary",
          action_id: "submit_consultation"
        }
      ]
    }
  ];
}

// メッセージイベント: ボット宛の発言はBlock Kit UIを表示
app.message(async ({ message, client, event, say }) => {
  try {
    // ボットのユーザーIDを取得
    const botUserId = await client.auth.test().then(res => res.user_id);
    
    // 編集されたメッセージの場合の処理
    let actualMessage = message;
    if (message.subtype === 'message_changed') {
      actualMessage = message.message;
    }
    
    // bot自身の編集は完全に無視
    if (message.subtype === 'message_changed' && 
        (message.message.user === botUserId || message.message.bot_id)) {
      return;
    }

    const isDirectMessage = actualMessage.channel_type === 'im';
    const isMentioned = actualMessage.text && actualMessage.text.includes(`<@${botUserId}>`);

    // DMかメンション時のみ反応
    if (!isDirectMessage && !isMentioned) return;

    // メンション部分を除去（メンションの場合）
    let userText = actualMessage.text || '';
    if (isMentioned) {
      userText = userText.replace(`<@${botUserId}>`, '').trim();
    }

    // 「相談」や「質問」などのキーワードが含まれているか、または空の場合はBlock Kit UIを表示
    if (userText === '' || 
        userText.includes('相談') || 
        userText.includes('質問') || 
        userText.includes('聞きたい') ||
        userText.includes('教えて') ||
        userText.length < 10) {
      
      const threadTs = message.subtype === 'message_changed' ? actualMessage.ts : message.ts;
      
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: "相談内容を入力してください",
        blocks: createConsultationBlocks()
      });
      
      return;
    }

    // 具体的な質問の場合は、従来の自動カテゴリ判定で処理
    handleDirectConsultation(userText, message, client);

  } catch (err) {
    console.error("Error in main message handler:", err);
    
    const threadTs = message.subtype === 'message_changed' ? message.message.ts : message.ts;
    
    await client.chat.postMessage({
      channel: message.channel,
      text: "すみません、ただいま回答できません。",
      thread_ts: threadTs
    });
  }
});

// Block Kit UIからの送信ボタンクリック処理
app.action('submit_consultation', async ({ ack, body, client }) => {
  await ack();

  try {
    const values = body.state.values;
    const selectedCategory = values.category_select.consultation_category.selected_option.value;
    const consultationText = values.consultation_input.consultation_text.value;
    
    if (!consultationText || consultationText.trim() === '') {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: "相談内容を入力してください。"
      });
      return;
    }

    console.log(`カテゴリ: ${selectedCategory}, 内容: ${consultationText}`);

    // 初回投稿（"回答中..."のプレースホルダー）
    const initialMessage = await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message.ts,
      text: "回答を生成中..."
    });

    const userId = body.user.id;
    const messageTs = body.message.ts;
    
    // 重複防止キー生成
    const crypto = require('crypto');
    const contentHash = crypto.createHash('md5').update(consultationText).digest('hex').substring(0, 8);
    const userKey = `${userId}-${messageTs}-${contentHash}`;
    
    // 重複処理を防ぐチェック
    if (processingUsers.has(userKey)) {
      console.log(`重複処理をスキップ: ${userKey}`);
      return;
    }
    
    processingUsers.add(userKey);
    
    // 現在時刻を記録
    const currentTime = Date.now();
    
    // 最終活動時刻をチェックして、1時間経過していれば自動リセット
    if (lastActivityTime[userId]) {
      const timeDiff = currentTime - lastActivityTime[userId];
      if (timeDiff > AUTO_RESET_INTERVAL) {
        delete conversationHistory[userId];
        console.log(`ユーザー ${userId} の会話履歴を自動リセット（${Math.round(timeDiff / 1000 / 60)}分経過）`);
      }
    }
    
    // 最終活動時刻を更新
    lastActivityTime[userId] = currentTime;
        
    // ユーザーの会話履歴を取得（なければ新規作成）
    let conversationId = conversationHistory[userId] || "";

    // バックグラウンドで非同期処理を実行
    processConsultationInBackground(
      userKey, 
      consultationText, 
      selectedCategory,
      conversationId, 
      userId, 
      body.channel.id,
      client, 
      initialMessage.ts
    );

  } catch (error) {
    console.error("Error handling consultation submission:", error);
    
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "エラーが発生しました。もう一度お試しください。"
    });
  }
});

// 直接的な質問の場合の処理（従来のロジック）
async function handleDirectConsultation(userText, message, client) {
  const userId = message.user;
  const messageTs = message.ts;
  
  // より確実な重複防止キー生成
  const crypto = require('crypto');
  const contentHash = crypto.createHash('md5').update(userText).digest('hex').substring(0, 8);
  const userKey = `${userId}-${messageTs}-${contentHash}`;
  
  // 重複処理を防ぐチェック
  if (processingUsers.has(userKey)) {
    console.log(`重複処理をスキップ: ${userKey}`);
    return;
  }
  
  processingUsers.add(userKey);
  
  // 現在時刻を記録
  const currentTime = Date.now();
  
  // 最終活動時刻をチェックして、1時間経過していれば自動リセット
  if (lastActivityTime[userId]) {
    const timeDiff = currentTime - lastActivityTime[userId];
    if (timeDiff > AUTO_RESET_INTERVAL) {
      delete conversationHistory[userId];
      console.log(`ユーザー ${userId} の会話履歴を自動リセット（${Math.round(timeDiff / 1000 / 60)}分経過）`);
    }
  }
  
  // 最終活動時刻を更新
  lastActivityTime[userId] = currentTime;
      
  // ユーザーの会話履歴を取得（なければ新規作成）
  let conversationId = conversationHistory[userId] || "";

  // 初回投稿（"回答中..."のプレースホルダー）
  const threadTs = message.subtype === 'message_changed' ? message.message.ts : message.ts;
  const initialMessage = await client.chat.postMessage({
    channel: message.channel,
    text: "回答を生成中...",
    thread_ts: threadTs
  });
  
  // 相談カテゴリを自動判定
  const consultationCategory = determineConsultationCategory(userText);
  
  // バックグラウンドで非同期処理を実行
  processConsultationInBackground(
    userKey,
    userText,
    consultationCategory,
    conversationId,
    userId,
    message.channel,
    client,
    initialMessage.ts
  );
}

// 相談カテゴリを判定する関数（従来のロジック）
function determineConsultationCategory(userText) {
  const text = userText.toLowerCase();
  
  if (text.includes('speeda') || text.includes('スピーダ') || text.includes('有償トライアルプラン') || text.includes('特約') || text.includes('関連')) {
    return 'SPEEDAについて';
  }
  
  if (text.includes('推進') || text.includes('進め方') || text.includes('方針') || text.includes('戦略')) {
    return 'プロジェクト推進方針について';
  }
  
  if (text.includes('NPL') || text.includes('販売') || text.includes('LEND') || text.includes('規約')) {
    return 'NPL販売について';
  }
  
  if (text.includes('NP法人プラン') || text.includes('管理') || text.includes('スピーダSF') || text.includes('商談')) {
    return 'NP法人プランについて';
  }
  
  if (text.includes('ERプラン') || text.includes('新設') || text.includes('戦略')) {
    return 'ERプランについて';
  }
  
  return 'その他';
}


// バックグラウンド処理を分離した関数
async function processConsultationInBackground(userKey, userText, consultationCategory, conversationId, userId, channelId, client, initialMessageTs) {
  try {
    // 処理開始前に再度重複チェック
    if (!processingUsers.has(userKey)) {
      console.log(`処理がキャンセルされました（バックグラウンド開始時）: ${userKey}`);
      return;
    }

    console.log(`バックグラウンド処理開始: ${userKey}`);
    console.log(`カテゴリ: ${consultationCategory}`);

    // Dify APIへリクエスト送信（ストリーミング対応）
    const response = await fetch("https://dify.app.uzabase.com/v1/chat-messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DIFY_API_KEY}`
      },
      body: JSON.stringify({
        inputs: {
          consultation_category: consultationCategory
        },
        query: userText,
        response_mode: "streaming",
        conversation_id: conversationId,
        user: userId
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // ストリーミングレスポンスの処理
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    let fullAnswer = '';
    let conversationIdFromStream = '';
    let updateCounter = 0;
    let lastUpdateTime = Date.now();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.slice(6);
              if (jsonStr.trim() === '' || jsonStr.trim() === '[DONE]') continue;
              
              const data = JSON.parse(jsonStr);
              
              // イベントタイプに応じた処理
              if (data.event === 'message' || data.event === 'agent_message') {
                if (data.answer) {
                  fullAnswer += data.answer;
                  updateCounter++;
                  
                  const currentTime = Date.now();
                  
                  // 更新頻度を制限（1秒間隔または文の終わりで）
                  if (currentTime - lastUpdateTime > 1000 || 
                      data.answer.includes('。') || 
                      data.answer.includes('！') || 
                      data.answer.includes('？') ||
                      data.answer.includes('\n')) {
                    
                    lastUpdateTime = currentTime;
                    
                    // Markdown記法を除去して更新
                    const cleanAnswer = removeMarkdownMarkup(fullAnswer);
                    
                    await client.chat.update({
                      channel: channelId,
                      ts: initialMessageTs,
                      text: cleanAnswer || "回答を生成中..."
                    });
                  }
                }
              } else if (data.event === 'message_end') {
                console.log('Message end event received');
              }
              
              // 会話IDの取得
              if (data.conversation_id) {
                conversationIdFromStream = data.conversation_id;
              }
              
              // レスポンスが空の場合の処理
              if (!data.event && data.answer && !fullAnswer) {
                fullAnswer = data.answer;
                const cleanAnswer = removeMarkdownMarkup(fullAnswer);
                await client.chat.update({
                  channel: channelId,
                  ts: initialMessageTs,
                  text: cleanAnswer
                });
              }
              
            } catch (parseError) {
              console.log('JSON parse error (normal for streaming):', parseError.message);
              continue;
            }
          }
        }
      }
      
      // 最終的な回答で更新（Markdown記法を除去）
      const cleanFinalAnswer = removeMarkdownMarkup(fullAnswer);
      const finalText = cleanFinalAnswer.trim() || "（エラーにより回答できません）";
      await client.chat.update({
        channel: channelId,
        ts: initialMessageTs,
        text: finalText
      });
      
      console.log(`Final answer length: ${fullAnswer.length}`);

    } catch (streamError) {
      console.error("Streaming error:", streamError);
      throw streamError;
    }

    // 新しい会話IDを保存
    if (conversationIdFromStream) {
      conversationHistory[userId] = conversationIdFromStream;
      console.log(`会話ID更新: ${conversationIdFromStream}`);
    }

  } catch (error) {
    console.error("Background processing error:", error);
    
    // エラー処理済みマークを設定（重複防止）
    if (!errorHandledMessages.has(userKey)) {
      errorHandledMessages.add(userKey);
      
      await client.chat.update({
        channel: channelId,
        ts: initialMessageTs,
        text: "すみません、ただいま回答できません。"
      });
    }
  } finally {
    // 処理完了後のクリーンアップ
    processingUsers.delete(userKey);
    
    // エラー管理は一定時間後に自動削除（メモリリーク防止）
    setTimeout(() => {
      errorHandledMessages.delete(userKey);
    }, 30000); // 30秒後に削除
  }
}

// Markdownの記法を除去する関数
function removeMarkdownMarkup(text) {
  if (!text) return text;
  
  return text
    // 太字記法を除去
    .replace(/\*\*(.*?)\*\*/g, '$1')  // **text** -> text
    .replace(/\*(.*?)\*/g, '$1')      // *text* -> text
    // 見出し記法を除去
    .replace(/^#{1,6}\s*/gm, '')      // # ## ### etc. -> (空文字)
    // リスト記法を除去
    .replace(/^\s*\*\s+/gm, '')       // * item -> item
    .replace(/^\s*-\s+/gm, '')        // - item -> item
    .replace(/^\s*\+\s+/gm, '')       // + item -> item
    // 番号付きリストを除去
    .replace(/^\s*\d+\.\s+/gm, '')    // 1. item -> item
    // 複数の改行を整理
    .replace(/\n{3,}/g, '\n\n')       // 3個以上の改行を2個に
    .trim();
}

// 会話履歴をリセットするコマンド
app.message(/^リセット$|^reset$|^新しい会話$/i, async ({ message, client }) => {
  try {
    const userId = message.user;
    delete conversationHistory[userId];
    delete lastActivityTime[userId];
    console.log(`ユーザー ${userId} の会話履歴を手動リセット`);
    
    await client.chat.postMessage({
      channel: message.channel,
      text: "会話履歴をリセットしました！新しい会話を始めましょう。",
      thread_ts: message.ts
    });
  } catch (err) {
    console.error("Error resetting conversation:", err);
  }
});

// 定期的な自動リセットチェック（5分ごと）
setInterval(() => {
  const currentTime = Date.now();
  const usersToReset = [];
  
  for (const userId in lastActivityTime) {
    const timeDiff = currentTime - lastActivityTime[userId];
    if (timeDiff > AUTO_RESET_INTERVAL) {
      usersToReset.push(userId);
    }
  }
  
  usersToReset.forEach(userId => {
    delete conversationHistory[userId];
    delete lastActivityTime[userId];
    console.log(`ユーザー ${userId} の会話履歴を定期自動リセット`);
  });
  
  if (usersToReset.length > 0) {
    console.log(`${usersToReset.length}名のユーザーの会話履歴を自動リセットしました`);
  }
}, 5 * 60 * 1000);

// アプリを起動
(async () => {
  await app.start();
  console.log('⚡️ Bot app is running!');
  console.log('会話履歴機能が有効です（Block Kit UI対応）');
})();
